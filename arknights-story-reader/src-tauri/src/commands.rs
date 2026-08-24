use crate::asset_service::AssetKind;
use crate::data_service::DataService;
use crate::models::{
    Chapter, ParsedStoryContent, SearchDebugResponse, SearchResult, SearchResultsPage,
    SegmentSearchPage, StoryCategory, StoryEntry, StoryIndexStatus, StoryPreviewToken,
};
use crate::parser::parse_story_text;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

pub struct AppState {
    pub data_service: Arc<Mutex<DataService>>,
}

// 安全获取锁，即使 Mutex 被 panic 污染也能恢复
fn lock_service(mutex: &Arc<Mutex<DataService>>) -> std::sync::MutexGuard<'_, DataService> {
    mutex.lock().unwrap_or_else(|poisoned| {
        eprintln!("[WARNING] Mutex was poisoned, recovering data");
        poisoned.into_inner()
    })
}

/// 拿一份 DataService 快照（两个 PathBuf 的克隆），立刻放锁。
/// 之后的磁盘 / SQLite 操作都在快照上进行，锁的持有时间是纳秒级。
fn clone_service(state: &State<'_, AppState>) -> DataService {
    let guard = lock_service(&state.data_service);
    let service = guard.clone();
    drop(guard);
    service
}

/// spawn_blocking 的 join 失败（几乎只可能是任务 panic）统一格式化。
/// 单独抽出来是为了让所有命令的错误串保持一种格式，也方便单测钉住。
fn join_error(task: &str, err: &dyn std::fmt::Display) -> String {
    format!("后台任务 {task} 异常中止: {err}")
}

/// 进程级安装互斥。sync_data / import_from_zip / import_from_zip_bytes
/// 都会改写同一组固定路径（ArknightsGameData*.zip、*_extract、*_old），
/// 前端虽有模块级锁，但 location.reload / ErrorBoundary 重载会把 JS 状态
/// 清零，而 Rust 侧的解压线程还在跑——第二次同步就会跟它抢路径。
/// 所以互斥必须落在 Rust 进程里。存的是当前持有者的任务 slug，
/// `None` 表示空闲；这把锁只护着这个 Option，临界区是纳秒级的，
/// 真正的磁盘工作由 RAII guard 的生命周期覆盖。
static INSTALL_LOCK: Mutex<Option<&'static str>> = Mutex::new(None);

/// 安装互斥的 RAII guard：随任务 move 进阻塞闭包，闭包正常返回或
/// panic（unwind）时 Drop 都会把锁放掉，绝不会把锁带进坟墓。
#[derive(Debug)]
struct InstallLockGuard;

impl Drop for InstallLockGuard {
    fn drop(&mut self) {
        let mut holder = INSTALL_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *holder = None;
    }
}

/// 尝试拿安装互斥。拿不到时立即返回中文错误（指明当前占用者），
/// 而不是排队等待——前端等一个不知何时结束的解压毫无意义，
/// 明确报错让用户稍后重试才是正确的交互。
fn acquire_install_lock(task: &'static str) -> Result<InstallLockGuard, String> {
    // 先把分块传输的弃单持有收走（见 IMPORT_TRANSFER_HOLD），否则一次
    // 页面重载留下的半截传输会把安装锁攥到进程退出。
    reap_stale_transfer_hold_at(Instant::now());
    let mut holder = INSTALL_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(current) = *holder {
        return Err(format!(
            "任务 {task} 无法启动: 后台任务 {current} 正在同步/导入数据（页面重载不会中止它），请等待其完成后再试"
        ));
    }
    *holder = Some(task);
    Ok(InstallLockGuard)
}

/// 分块传输在途时寄存的安装互斥持有。首块拿到 INSTALL_LOCK 后不再立刻
/// 放掉，而是寄存在这里、由后续块取走接力、收尾块带进导入流程：整个
/// 传输期间 sync_data / 其他导入会立刻得到明确报错，而不是等用户传完
/// 几百 MB 后才在收尾撞锁。读类命令从不碰 INSTALL_LOCK，寄存不影响
/// 任何读取。
///
/// WebView 重载 / 前端崩溃会让传输无声中止，没有任何回调能来放锁，
/// 所以持有里记着最后一块的落盘时间：静默超过 IMPORT_TRANSFER_STALE
/// 后，下一个抢锁者（见 acquire_install_lock）会把它当弃单收走。
///
/// 锁序约定：持这把 Mutex 期间可以 Drop 里面的 InstallLockGuard（它会
/// 去锁 INSTALL_LOCK），反向嵌套不存在——INSTALL_LOCK 的临界区从不碰
/// 这里。
struct ImportTransferHold {
    guard: InstallLockGuard,
    last_chunk_at: Instant,
}

static IMPORT_TRANSFER_HOLD: Mutex<Option<ImportTransferHold>> = Mutex::new(None);

/// 前端逐块 await 上传，正常块间隔是毫秒级；整整一分钟没有新块只可能
/// 是传输已死。取宽不取严：误杀活传输会让导入莫名失败，晚一分钟解锁
/// 只是让 sync 多等一会。
const IMPORT_TRANSFER_STALE: Duration = Duration::from_secs(60);

fn lock_transfer_hold() -> std::sync::MutexGuard<'static, Option<ImportTransferHold>> {
    IMPORT_TRANSFER_HOLD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 取走寄存的持有（若有）。offset 0 的新一轮传输用它作废上一轮，
/// 续传块用它接手继续持锁。
fn take_transfer_hold() -> Option<InstallLockGuard> {
    lock_transfer_hold().take().map(|hold| hold.guard)
}

/// 一块落盘成功后把持有放回寄存处并刷新活跃时间，等下一块来取。
fn stow_transfer_hold(guard: InstallLockGuard) {
    *lock_transfer_hold() = Some(ImportTransferHold {
        guard,
        last_chunk_at: Instant::now(),
    });
}

/// 判定寄存持有是否已是弃单。单独抽成纯函数是为了让单测不必真等一
/// 分钟；saturating 语义顺带把「now 早于 last_chunk_at」按不过期处理。
fn transfer_hold_is_stale(last_chunk_at: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_chunk_at) >= IMPORT_TRANSFER_STALE
}

/// 把过期的寄存持有收走（Drop 即释放 INSTALL_LOCK）。任何抢安装锁的
/// 任务都先来收一次尸，保证弃单不会把同步永久锁死。
fn reap_stale_transfer_hold_at(now: Instant) {
    let mut slot = lock_transfer_hold();
    if slot
        .as_ref()
        .is_some_and(|hold| transfer_hold_is_stale(hold.last_chunk_at, now))
    {
        *slot = None;
    }
}

/// 所有走阻塞线程池的命令共用的外壳：`task` 用命令名做 slug 方便从
/// 日志反查；任务 panic 时把 JoinError 转成统一格式的 Err 字符串抛回
/// 前端，绝不让 panic 穿透命令边界。
async fn run_blocking<T, F>(task: &'static str, job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|err| join_error(task, &err))?
}

#[tauri::command]
pub async fn sync_data(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // guard 必须 move 进阻塞闭包：命令的 async 外壳在 WebView 重载后
    // 可能先行消亡，锁的寿命要跟真正的下载/解压线程对齐。
    let guard = acquire_install_lock("sync_data")?;
    let service = clone_service(&state);
    run_blocking("sync_data", move || {
        let _guard = guard;
        service.sync_data(app)
    })
    .await
}

#[tauri::command]
pub async fn get_current_version(state: State<'_, AppState>) -> Result<String, String> {
    let service = clone_service(&state);
    run_blocking("get_current_version", move || service.get_current_version()).await
}

#[tauri::command]
pub async fn get_remote_version(state: State<'_, AppState>) -> Result<String, String> {
    let service = clone_service(&state);
    run_blocking("get_remote_version", move || service.get_remote_version()).await
}

#[tauri::command]
pub async fn check_update(state: State<'_, AppState>) -> Result<bool, String> {
    let service = clone_service(&state);
    run_blocking("check_update", move || service.check_update()).await
}

/// `is_installed` 底下是一次磁盘 stat；看似轻，但在冷缓存 / 网络盘上
/// 也可能卡几十毫秒，别拿着锁在 async worker 上做。
#[tauri::command]
pub async fn is_installed(state: State<'_, AppState>) -> Result<bool, String> {
    let service = clone_service(&state);
    run_blocking("is_installed", move || Ok(service.is_installed())).await
}

#[tauri::command]
pub async fn get_chapters(state: State<'_, AppState>) -> Result<Vec<Chapter>, String> {
    let service = clone_service(&state);
    run_blocking("get_chapters", move || service.get_chapters()).await
}

#[tauri::command]
pub async fn get_story_categories(
    state: State<'_, AppState>,
) -> Result<Vec<StoryCategory>, String> {
    let service = clone_service(&state);
    run_blocking("get_story_categories", move || {
        service.get_story_categories()
    })
    .await
}

/// 剧情 / 简介路径必须是数据目录内的相对路径。合法值全部来自游戏
/// JSON（`obt/main/...`、`activities/...`、`info/...`、`[uc]info/...`），
/// 从不含 `..` 组件、不以 `/` 或 `\` 开头、不含 `:`。而 DataService
/// 侧是裸 `PathBuf::join`：`..` 能一路爬出数据目录，以 `/`、`\` 开头
/// 或带盘符（`C:`）的路径更会让 join 直接替换掉基目录——阅读器渲染
/// 的是用户自行导入的 ZIP 里的文本，一旦 WebView 被注入，这三个命令
/// 就是读任意 `*.txt` 的跳板。校验放在 IPC 边界，拒绝时明说原路径。
fn ensure_story_relative_path(path: &str) -> Result<(), String> {
    let escapes = path.starts_with('/')
        || path.starts_with('\\')
        || path.contains(':')
        || path
            .split(|c| c == '/' || c == '\\')
            .any(|segment| segment == "..");
    if escapes {
        return Err(format!("非法的剧情路径: {path}"));
    }
    Ok(())
}

/// 读盘 + 解析一整篇剧情，长的有几千行；放到阻塞线程池里，
/// 否则 WebView 每翻一篇就把一个 async worker 占满。
#[tauri::command]
pub async fn get_story_content(
    state: State<'_, AppState>,
    story_path: String,
) -> Result<ParsedStoryContent, String> {
    ensure_story_relative_path(&story_path)?;
    let service = clone_service(&state);
    run_blocking("get_story_content", move || {
        let content = service.read_story_text(&story_path)?;
        Ok(parse_story_text(&content))
    })
    .await
}

#[tauri::command]
pub async fn get_story_info(
    state: State<'_, AppState>,
    info_path: String,
) -> Result<String, String> {
    ensure_story_relative_path(&info_path)?;
    let service = clone_service(&state);
    run_blocking("get_story_info", move || {
        service.read_story_info(&info_path)
    })
    .await
}

#[tauri::command]
pub async fn get_story_entry(
    state: State<'_, AppState>,
    story_id: String,
) -> Result<StoryEntry, String> {
    let service = clone_service(&state);
    run_blocking("get_story_entry", move || {
        service.get_story_entry(&story_id)
    })
    .await
}

#[tauri::command]
pub async fn get_story_preview_token(
    state: State<'_, AppState>,
    story_path: String,
) -> Result<Option<StoryPreviewToken>, String> {
    ensure_story_relative_path(&story_path)?;
    let service = clone_service(&state);
    run_blocking("get_story_preview_token", move || {
        service.get_story_preview_token(&story_path)
    })
    .await
}

#[tauri::command]
pub async fn get_story_index_status(
    state: State<'_, AppState>,
) -> Result<StoryIndexStatus, String> {
    let service = clone_service(&state);
    run_blocking("get_story_index_status", move || {
        service.get_story_index_status()
    })
    .await
}

#[tauri::command]
pub async fn build_story_index(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let service = clone_service(&state);
    run_blocking("build_story_index", move || {
        service.rebuild_story_index_with_progress(&app)
    })
    .await
}

/// FTS 查询 + 可能的全量线性扫描（索引缺失时能跑好几秒），
/// 绝不能拿着锁在 async worker 上做。
#[tauri::command]
pub async fn search_stories(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    let service = clone_service(&state);
    run_blocking("search_stories", move || service.search_stories(&query)).await
}

#[tauri::command]
pub async fn search_stories_ex(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
) -> Result<SearchResultsPage, String> {
    let service = clone_service(&state);
    run_blocking("search_stories_ex", move || {
        service.search_stories_ex_with_progress(&app, &query)
    })
    .await
}

#[tauri::command]
pub async fn search_segments(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
) -> Result<SegmentSearchPage, String> {
    let service = clone_service(&state);
    run_blocking("search_segments", move || {
        service.search_segments_with_progress(&app, &query)
    })
    .await
}

#[tauri::command]
pub async fn search_stories_with_progress(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    let service = clone_service(&state);
    run_blocking("search_stories_with_progress", move || {
        service.search_stories_with_progress(&app, &query)
    })
    .await
}

#[tauri::command]
pub async fn search_stories_debug(
    state: State<'_, AppState>,
    query: String,
) -> Result<SearchDebugResponse, String> {
    let service = clone_service(&state);
    run_blocking("search_stories_debug", move || {
        service.search_stories_with_debug(&query)
    })
    .await
}

#[tauri::command]
pub async fn import_from_zip(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let guard = acquire_install_lock("import_from_zip")?;
    let service = clone_service(&state);
    run_blocking("import_from_zip", move || {
        let _guard = guard;
        service.import_zip_from_path(path, app)
    })
    .await
}

/// 分块传输被打断（乱序 / 暂存文件失踪）时的统一话术。
const IMPORT_STREAM_BROKEN: &str = "导入传输中断，数据块不连续，请重新选择文件导入";

const IMPORT_CHUNK_ENCODING_BROKEN: &str = "ZIP 数据块编码损坏，请重新选择文件导入";

/// 解码标准 base64（FileReader dataURL 用的字母表，含可选 `=` 填充）。
/// 项目依赖里没有 base64 crate，为一个函数添依赖不值当，这里手写一个
/// 严格版：拒绝空白与非法长度，宁可让前端整轮重传也不拼出坏数据。
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn sextet(c: u8) -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok(u32::from(c - b'A')),
            b'a'..=b'z' => Ok(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Ok(u32::from(c - b'0') + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(IMPORT_CHUNK_ENCODING_BROKEN.to_string()),
        }
    }

    let stripped = input
        .strip_suffix("==")
        .or_else(|| input.strip_suffix('='))
        .unwrap_or(input)
        .as_bytes();
    // 每 4 个字符解出 3 字节；余 1 个字符连一个字节都凑不出，必是坏块。
    if stripped.len() % 4 == 1 {
        return Err(IMPORT_CHUNK_ENCODING_BROKEN.to_string());
    }
    let mut out = Vec::with_capacity(stripped.len() / 4 * 3 + 2);
    for group in stripped.chunks(4) {
        let mut acc = 0u32;
        for &c in group {
            acc = (acc << 6) | sextet(c)?;
        }
        match group.len() {
            4 => out.extend_from_slice(&[(acc >> 16) as u8, (acc >> 8) as u8, acc as u8]),
            3 => out.extend_from_slice(&[(acc >> 10) as u8, (acc >> 2) as u8]),
            2 => out.push((acc >> 4) as u8),
            _ => return Err(IMPORT_CHUNK_ENCODING_BROKEN.to_string()),
        }
    }
    Ok(out)
}

/// 暂存文件生命周期的专用互斥。三种触碰暂存文件的操作全部串行在这把
/// 小锁下：追加（append_import_chunk 的「查长度 → 写入」）、收尾转正
/// （promote_import_staging 的「确认存在 → 改名」）、显式中止的删除
/// （abort_import_transfer）。它们各自都是「先检查后动作」的两步，
/// 若不互斥，上一轮传输滞留在阻塞线程池里的迟到块可以插进任意一对
/// 检查与动作之间：追加会绕过偏移校验拼出损坏的 ZIP，转正会把迟到
/// 字节一起改名带走（或让迟到块写进已转正的文件），删除会被复活的
/// 半截文件抵消。串行之后迟到块只剩统一结局——排在前面被偏移校验
/// 拒掉，或排在后面看到已变化的长度 / 已缺失的暂存而快速失败。
///
/// 锁序约定：三个入口都在持有 INSTALL_LOCK（guard）期间才来拿这把锁，
/// 固定方向是 INSTALL_LOCK → IMPORT_CHUNK_LOCK，禁止反向（持这把锁去
/// 抢安装互斥，包括在临界区内 Drop InstallLockGuard）。临界区只允许
/// 纳秒级的 stat / 顺序写 / rename / remove；耗时的校验解压必须放锁后
/// 进行，否则迟到块的快速失败会被堵成慢失败。
static IMPORT_CHUNK_LOCK: Mutex<()> = Mutex::new(());

/// 显式中止在途的分块传输：取走寄存的安装互斥持有并清理暂存文件。
///
/// 寄存已空只说明这轮传输不占着锁，半截 `.part` 却未必不在：某块在
/// 后端失败（解码 / 落盘报错）时 guard 已随错误一起 Drop，暂存文件
/// 留在盘上，不清理就要躺到下次启动。所以寄存为空时改为当场抢一次
/// 安装互斥：抢到证明没有任何同步 / 导入 / 收尾在跑，删暂存是安全的
/// （持锁期间新一轮传输的首块拿不到锁，不存在被误删的活暂存）；
/// 抢不到说明 sync / 导入收尾正占着这组路径，严格 no-op——此时删
/// 文件反而可能误伤它们正在处理的暂存。清理失败不影响放锁：guard
/// 在返回前无条件 Drop，INSTALL_LOCK 一定回到空闲。
fn abort_import_transfer(staging: &std::path::Path) -> Result<(), String> {
    let guard = match take_transfer_hold() {
        Some(guard) => guard,
        None => match acquire_install_lock("import_from_zip_bytes") {
            Ok(guard) => guard,
            Err(_) => return Ok(()),
        },
    };
    // 删除与追加共用 IMPORT_CHUNK_LOCK：滞留在阻塞线程池里的迟到块
    // 要么先落盘随后被删，要么在删除后看到暂存缺失报「中断」，
    // 绝不会在删除后复活一个半截文件。
    let removal = {
        let _serialized = IMPORT_CHUNK_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match std::fs::remove_file(staging) {
            Ok(()) => Ok(()),
            // 暂存本就不存在（首块还没落盘就失败了）不算错。
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("清理导入暂存文件失败: {}", err)),
        }
    };
    drop(guard);
    removal
}

/// 把解码后的一块字节追加到暂存文件。`offset == 0` 开新文件（顺带截断
/// 上一轮半途而废的暂存）；其余块要求偏移与暂存文件当前长度严格相等，
/// 乱序 / 串台宁可报错让用户重传，也不能悄悄拼出一个损坏的 ZIP。
/// 「查长度 → 写入」全程握着 IMPORT_CHUNK_LOCK，保证校验与落盘原子。
fn append_import_chunk(staging: &std::path::Path, offset: u64, chunk: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let _serialized = IMPORT_CHUNK_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some(parent) = staging.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建数据目录: {}", e))?;
    }
    let mut file = if offset == 0 {
        std::fs::File::create(staging).map_err(|e| format!("写入 ZIP 数据失败: {}", e))?
    } else {
        // 暂存文件失踪（被上一轮收尾改名走了 / 用户清了缓存）说明这轮
        // 传输已经废了，报「中断」而不是含糊的 IO 错误。
        if !staging.exists() {
            return Err(IMPORT_STREAM_BROKEN.to_string());
        }
        let file = std::fs::OpenOptions::new()
            .append(true)
            .open(staging)
            .map_err(|e| format!("写入 ZIP 数据失败: {}", e))?;
        let len = file
            .metadata()
            .map_err(|e| format!("写入 ZIP 数据失败: {}", e))?
            .len();
        if len != offset {
            return Err(IMPORT_STREAM_BROKEN.to_string());
        }
        file
    };
    file.write_all(chunk)
        .map_err(|e| format!("写入 ZIP 数据失败: {}", e))?;
    Ok(())
}

/// 收尾块把写完的暂存文件转正：确认它存在，并原子改名成导入临时 ZIP。
///
/// 「exists → rename」全程握着 IMPORT_CHUNK_LOCK，与迟到块的追加互斥。
/// 若不互斥（旧实现把这两步放在 DataService 里裸跑），迟到块可以在
/// exists 之后、rename 之前打开暂存文件——rename 只改目录项不换 inode，
/// 迟到字节会顺着还开着的句柄写进已转正的 ZIP，悄悄写坏它；也可能在
/// rename 之后才走到追加，得到含糊的 IO 错误而不是明确的「传输中断」。
/// 串行之后迟到块只有两种结局：排在转正之前，要么被偏移校验拒掉、
/// 要么完整落盘后才轮到改名（改名带走的永远是一个完整一致的文件，
/// 绝无写到一半被改名的撕裂）；排在转正之后，看到暂存缺失，秒回
/// IMPORT_STREAM_BROKEN。
///
/// 锁内只有一次 stat 加一次 rename（纳秒级）；耗时的校验解压由调用方在
/// 放锁之后做（DataService::import_promoted_zip），不会堵住迟到块的
/// 快速失败。调用时机在收尾块 append 成功之后，此时安装互斥（guard）
/// 仍在手上，锁序仍是 INSTALL_LOCK → IMPORT_CHUNK_LOCK。
fn promote_import_staging(
    staging: &std::path::Path,
    dest: &std::path::Path,
) -> Result<(), String> {
    let _serialized = IMPORT_CHUNK_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // 收尾时暂存缺失只能是这轮传输从未落盘 / 已被显式中止清理，
    // 沿用原有话术引导用户重选文件，而不是报含糊的改名 IO 错误。
    if !staging.exists() {
        return Err("暂存的 ZIP 数据不存在，请重新选择文件导入".to_string());
    }
    // Windows 的 rename 不覆盖已存在的目标。上一次导入若在改名转正之后、
    // finalize 删临时 ZIP 之前崩溃/断电（或按路径导入 fs::copy 到一半
    // 失败），dest 会残留一个弃单——启动清理特意只删 `.part` 不碰它。
    // 不先清掉，Windows 上此后每一轮分块导入都会在收尾报「写入 ZIP
    // 数据失败」，重试、重启都救不回来。此刻 INSTALL_LOCK 与
    // IMPORT_CHUNK_LOCK 都在手上，没有任何同步/导入在用这个路径，
    // dest 只可能是弃单，删掉是安全的。
    match std::fs::remove_file(dest) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(format!("清理残留的导入临时文件失败: {}", err)),
    }
    std::fs::rename(staging, dest).map_err(|e| format!("写入 ZIP 数据失败: {}", e))
}

/// 分块导入 ZIP。前端把文件切成几 MB 的块，逐块 base64 后调用本命令。
///
/// 为什么不直接传字节：Tauri 2 在 Android 上的 IPC 走 postMessage，
/// 参数一律 JSON 化，`Vec<u8>` 会被展开成 JSON 数字数组——本命令旧签名
/// 一次收整包，几百 MB 的 ZIP 序列化后直接把 WebView 撑爆（OOM 事故
/// 现场）；raw IPC body 在 Android 上同样不可用（`InvokeBody::Raw`
/// 文档明说 Android 恒为 Json），官方给 Android 的建议正是 base64
/// 字符串。块大小由前端控制，两端峰值内存都只有一块的量级，与文件
/// 总大小无关。
///
/// 协议：`offset` 是该块在文件中的字节偏移，0 表示开启新一轮传输
/// （创建 / 截断暂存文件）；后端校验 offset 必须等于暂存文件当前长度，
/// 防止 WebView 重载后旧传输的尾巴混进新传输。`last` 为 true 时收尾：
/// 把暂存文件改名为导入临时 ZIP，走统一导入流程。`cancel` 为 true 时
/// 显式中止本轮传输（其余参数忽略）：放掉寄存的安装互斥并清理暂存
/// 文件——复用本命令做中止是刻意的，省得再注册一个 invoke handler。
///
/// 安装互斥从首块一路持到收尾，块与块之间寄存在 IMPORT_TRANSFER_HOLD：
/// sync_data 在传输中途插进来会立刻失败，而不是等用户传完几百 MB 后
/// 收尾块才撞锁、整轮上传白费。传输半途而废（WebView 重载）时寄存的
/// 持有会在静默超时后被下一个抢锁者收走，不会把同步永久锁死。
#[tauri::command]
pub async fn import_from_zip_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    chunk_base64: String,
    offset: u64,
    last: bool,
    cancel: Option<bool>,
) -> Result<(), String> {
    // 显式中止分支：FileReader 读块失败 / 某块 IPC 根本没送达后端时，
    // 前端不会再有后续块来接力，寄存的持有只能干等 60 秒弃单超时，
    // 期间用户点同步只会看到「导入正在进行」。前端在 catch 里带
    // cancel=true 再调一次本命令，立刻放锁并删掉半截 `.part`；
    // 弃单超时降级为它失败时的兜底。
    if cancel.unwrap_or(false) {
        let service = clone_service(&state);
        return run_blocking("import_from_zip_bytes", move || {
            match service.import_staging_path() {
                Ok(staging) => abort_import_transfer(&staging),
                Err(err) => {
                    // 放锁优先于清理：暂存路径都推导不出也不能把寄存
                    // 持有留到弃单超时。
                    drop(take_transfer_hold());
                    Err(err)
                }
            }
        })
        .await;
    }
    let guard = if offset == 0 {
        // 新一轮传输：上一轮的寄存持有（若有）直接作废——offset 0 本就
        // 会截断重写暂存文件。随后重新抢锁，抢不到说明真有同步/导入
        // 在跑，第一块就快速失败。
        drop(take_transfer_hold());
        acquire_install_lock("import_from_zip_bytes")?
    } else {
        // 续传块：取回寄存的持有接着扛。寄存已空说明持有被当弃单收走
        // 了（传输停顿超时）或进程重启过，重新抢锁接续；抢不到说明
        // 空档期里同步已经插进来，这轮传输注定失败，立即报错。
        match take_transfer_hold() {
            Some(guard) => guard,
            None => acquire_install_lock("import_from_zip_bytes")?,
        }
    };
    let service = clone_service(&state);
    run_blocking("import_from_zip_bytes", move || {
        let chunk = decode_base64(&chunk_base64)?;
        let staging = service.import_staging_path()?;
        // 解码或落盘失败会把 guard 一起带走（Drop 放锁）：废掉的传输
        // 不该继续占着安装互斥。
        append_import_chunk(&staging, offset, &chunk)?;
        if last {
            let _guard = guard;
            // 转正（确认存在 + 改名）在 IMPORT_CHUNK_LOCK 内完成，与迟到
            // 块的追加互斥；随后的校验解压不再持 chunk 锁，迟到块会立刻
            // 看到暂存缺失、秒拿「传输中断」而不是等解压结束。
            promote_import_staging(&staging, &service.import_temp_zip_path()?)?;
            service.import_promoted_zip(app)
        } else {
            stow_transfer_hold(guard);
            Ok(())
        }
    })
    .await
}

#[tauri::command]
pub async fn get_main_stories_grouped(
    state: State<'_, AppState>,
) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
    let service = clone_service(&state);
    run_blocking("get_main_stories_grouped", move || {
        service.get_main_stories_grouped()
    })
    .await
}

#[tauri::command]
pub async fn get_activity_stories_grouped(
    state: State<'_, AppState>,
) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
    let service = clone_service(&state);
    run_blocking("get_activity_stories_grouped", move || {
        service.get_activity_stories_grouped()
    })
    .await
}

#[tauri::command]
pub async fn get_sidestory_stories_grouped(
    state: State<'_, AppState>,
) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
    let service = clone_service(&state);
    run_blocking("get_sidestory_stories_grouped", move || {
        service.get_sidestory_stories_grouped()
    })
    .await
}

#[tauri::command]
pub async fn get_roguelike_stories_grouped(
    state: State<'_, AppState>,
) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
    let service = clone_service(&state);
    run_blocking("get_roguelike_stories_grouped", move || {
        service.get_roguelike_stories_grouped()
    })
    .await
}

#[tauri::command]
pub async fn get_memory_stories(state: State<'_, AppState>) -> Result<Vec<StoryEntry>, String> {
    let service = clone_service(&state);
    run_blocking("get_memory_stories", move || service.get_memory_stories()).await
}

/// 前端传来的 kind 字符串 → AssetKind。两种别名（snake_case 与
/// camelCase）都收，跟 `src/lib/assetUrls.ts` 保持一致。
fn parse_asset_kind(kind: &str) -> Result<AssetKind, String> {
    match kind {
        "avatar" => Ok(AssetKind::Avatar),
        "portrait" => Ok(AssetKind::Portrait),
        "image" => Ok(AssetKind::Image),
        "background" => Ok(AssetKind::Background),
        "activity_kv" | "activityKv" => Ok(AssetKind::ActivityKv),
        "activity_logo" | "activityLogo" => Ok(AssetKind::ActivityLogo),
        "chapter_cover" | "chapterCover" => Ok(AssetKind::ChapterCover),
        other => Err(format!("unknown asset kind: {}", other)),
    }
}

/// 素材 URL 解析：返回一条按优先级排序的候选列表，前端 `<AssetImage>`
/// 依次尝试。不做网络请求，不做缓存（WebView 自己会缓存）。
/// 纯内存字符串拼接，不值得进阻塞线程池。
#[tauri::command]
pub async fn resolve_asset_urls(kind: String, token: String) -> Result<Vec<String>, String> {
    let kind_enum = parse_asset_kind(&kind)?;
    Ok(crate::asset_service::resolve(kind_enum, &token))
}

/// 拿到一份干员 name↔charId 快照，前端启动时调用一次并缓存在内存。
/// `character_table_path` 要 stat 磁盘，refresh 还得读几兆 JSON，
/// 整段都进阻塞线程池，锁只在克隆快照那一瞬间持有。
#[tauri::command]
pub async fn get_character_index(
    state: State<'_, AppState>,
) -> Result<crate::character_table::CharacterIndex, String> {
    let service = clone_service(&state);
    run_blocking("get_character_index", move || {
        // Best-effort refresh from live data directory if present.
        if let Some(path) = service.character_table_path() {
            crate::character_table::refresh_from_file(&path);
        }
        Ok(crate::character_table::snapshot())
    })
    .await
}

/// 根据 storyId 返回 prev/next 剧情条目（按 storyGroup + storySort 推导）。
#[tauri::command]
pub async fn get_story_neighbors(
    state: State<'_, AppState>,
    story_id: String,
) -> Result<crate::models::StoryNeighbors, String> {
    let service = clone_service(&state);
    run_blocking("get_story_neighbors", move || {
        service.get_story_neighbors(&story_id)
    })
    .await
}

/// 返回 storyId 所在的章节 / 活动显示名（例如 "黑暗时代·上"）。
#[tauri::command]
pub async fn get_story_category_name(
    state: State<'_, AppState>,
    story_id: String,
) -> Result<Option<String>, String> {
    let service = clone_service(&state);
    run_blocking("get_story_category_name", move || {
        service.get_story_category_name(&story_id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn join_error_message_is_unified() {
        assert_eq!(
            join_error("demo_task", &"boom"),
            "后台任务 demo_task 异常中止: boom"
        );
    }

    #[test]
    fn run_blocking_passes_ok_through() {
        let result: Result<u32, String> =
            tauri::async_runtime::block_on(run_blocking("ok_task", || Ok(7)));
        assert_eq!(result, Ok(7));
    }

    #[test]
    fn run_blocking_passes_err_through_untouched() {
        let result: Result<u32, String> = tauri::async_runtime::block_on(run_blocking(
            "err_task",
            || Err("原样透传".to_string()),
        ));
        assert_eq!(result, Err("原样透传".to_string()));
    }

    /// 命令边界的「绝不 panic」保证：任务 panic 只会变成统一格式的
    /// Err 字符串，不会把 panic 抛给 WebView。
    #[test]
    fn run_blocking_turns_panic_into_unified_error() {
        let result: Result<(), String> =
            tauri::async_runtime::block_on(run_blocking("panicky_task", || {
                panic!("deliberate test panic")
            }));
        let err = result.expect_err("panic 必须以 Err 形式浮出");
        assert!(
            err.starts_with("后台任务 panicky_task 异常中止: "),
            "错误串未按统一格式生成: {err}"
        );
    }

    #[test]
    fn parse_asset_kind_accepts_all_documented_aliases() {
        let cases = [
            ("avatar", AssetKind::Avatar),
            ("portrait", AssetKind::Portrait),
            ("image", AssetKind::Image),
            ("background", AssetKind::Background),
            ("activity_kv", AssetKind::ActivityKv),
            ("activityKv", AssetKind::ActivityKv),
            ("activity_logo", AssetKind::ActivityLogo),
            ("activityLogo", AssetKind::ActivityLogo),
            ("chapter_cover", AssetKind::ChapterCover),
            ("chapterCover", AssetKind::ChapterCover),
        ];
        for (input, expected) in cases {
            assert_eq!(
                parse_asset_kind(input),
                Ok(expected),
                "kind {input} 解析失败"
            );
        }
    }

    #[test]
    fn parse_asset_kind_rejects_unknown_kind() {
        let err = parse_asset_kind("sprite").expect_err("未知 kind 必须报错");
        assert!(err.contains("sprite"), "错误信息应包含原始 kind: {err}");
    }

    /// 游戏 JSON 里真实出现的全部路径形态必须放行——校验绝不能误伤
    /// 正常阅读。
    #[test]
    fn story_relative_path_accepts_real_data_shapes() {
        for path in [
            "obt/main/level_main_00-01_beg",
            "activities/act9d0/level_act9d0_01_beg",
            "obt/memory/story_char_002_amiya_mem_1",
            "info/activities/act9d0/level_act9d0_01",
            "[uc]info/activities/act9d0/level_act9d0_01",
            "obt/roguelike/ro1/level_rogue1_1-1",
        ] {
            ensure_story_relative_path(path).unwrap_or_else(|err| {
                panic!("真实数据路径 {path} 不该被拒绝: {err}");
            });
        }
    }

    /// 能逃出数据目录的形态必须全部被拒：`..` 组件（两种分隔符）、
    /// 以 `/` 或 `\` 开头（PathBuf::join 会替换基目录）、盘符 / NTFS
    /// 数据流（含 `:`）。
    #[test]
    fn story_relative_path_rejects_traversal() {
        for path in [
            "..",
            "../secret",
            "a/../../b",
            "..\\windows\\secret",
            "info/..\\..\\secret",
            "/etc/passwd",
            "\\\\server\\share\\x",
            "C:/Users/x",
            "C:\\Users\\x",
            "story.txt:stream",
        ] {
            let err = ensure_story_relative_path(path).expect_err(path);
            assert!(err.contains(path), "错误应包含原路径以便排查: {err}");
        }
    }

    /// 拒绝逻辑的另一半边界：段里含点但整段不是 `..` 的路径必须放行。
    /// 校验器按整段与 `..` 精确比对；若有人日后把它改成「包含 ..」或
    /// 「以 . 开头」的宽松匹配，看似更严，实际会把这类 join 之后仍在
    /// 数据目录内的合法相对路径误拒——阅读直接坏掉且没有任何安全收益。
    #[test]
    fn story_relative_path_keeps_dotty_but_safe_segments() {
        for path in [
            "..a/story",
            "a../story",
            "a..b/story",
            "a/.../b",
            "obt/main/level_main_10..5",
            ".hidden/story",
            "info/act.rep.1/level_x",
        ] {
            ensure_story_relative_path(path).unwrap_or_else(|err| {
                panic!("含点但安全的路径 {path} 不该被误拒: {err}");
            });
        }
    }

    /// 测试专用的参照编码器：手写解码器的正确性用「任意字节 → 编码 →
    /// 解码 → 原样还原」来钉住，不依赖记忆中的向量表。
    fn encode_base64(data: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for group in data.chunks(3) {
            let b = [
                group[0],
                group.get(1).copied().unwrap_or(0),
                group.get(2).copied().unwrap_or(0),
            ];
            let acc = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            out.push(ALPHABET[(acc >> 18) as usize & 63] as char);
            out.push(ALPHABET[(acc >> 12) as usize & 63] as char);
            out.push(if group.len() > 1 {
                ALPHABET[(acc >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if group.len() > 2 {
                ALPHABET[acc as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }

    #[test]
    fn decode_base64_matches_rfc4648_vectors() {
        let cases: &[(&str, &[u8])] = &[
            ("", b""),
            ("Zg==", b"f"),
            ("Zm8=", b"fo"),
            ("Zm9v", b"foo"),
            ("Zm9vYg==", b"foob"),
            ("Zm9vYmE=", b"fooba"),
            ("Zm9vYmFy", b"foobar"),
        ];
        for (input, expected) in cases {
            assert_eq!(
                decode_base64(input).as_deref(),
                Ok(*expected),
                "输入 {input}"
            );
        }
    }

    #[test]
    fn decode_base64_roundtrips_arbitrary_bytes() {
        // 覆盖全部 256 个字节值，以及各种「除 3 的余数」的长度。
        let all_bytes: Vec<u8> = (0u8..=255).collect();
        let mut cases: Vec<&[u8]> = vec![&all_bytes];
        for len in 0..=5 {
            cases.push(&all_bytes[..len]);
        }
        for data in cases {
            let encoded = encode_base64(data);
            assert_eq!(
                decode_base64(&encoded).as_deref(),
                Ok(data),
                "长度 {} 的字节串必须原样还原",
                data.len()
            );
        }
    }

    #[test]
    fn decode_base64_rejects_garbage() {
        // FileReader 产出的 base64 没有空白和换行，混进来就是坏块。
        for input in ["Zm 9v", "Zm9v\n", "A", "Z=9v", "Zm9v!!"] {
            let err = decode_base64(input).expect_err("坏块必须被拒绝");
            assert!(err.contains("编码损坏"), "输入 {input:?}: {err}");
        }
    }

    #[test]
    fn append_import_chunk_enforces_sequential_offsets() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("askr_import_chunk_{nanos}"));
        let staging = dir.join("staging.part");

        append_import_chunk(&staging, 0, b"hello ").expect("首块必须成功（自动建目录）");
        append_import_chunk(&staging, 6, b"world").expect("偏移衔接的追加必须成功");
        assert_eq!(std::fs::read(&staging).unwrap(), b"hello world");

        let err = append_import_chunk(&staging, 5, b"!").expect_err("乱序偏移必须被拒绝");
        assert!(err.contains("不连续"), "{err}");
        assert_eq!(
            std::fs::read(&staging).unwrap(),
            b"hello world",
            "被拒绝的块不能污染暂存文件"
        );

        // offset 0 重开一轮：上一轮的残骸必须被截断。
        append_import_chunk(&staging, 0, b"redo").expect("重开一轮必须成功");
        assert_eq!(std::fs::read(&staging).unwrap(), b"redo");

        // 暂存文件失踪（收尾已改名 / 缓存被清）时续传必须报「中断」。
        std::fs::remove_file(&staging).unwrap();
        let err = append_import_chunk(&staging, 4, b"tail").expect_err("暂存缺失必须报错");
        assert!(err.contains("不连续"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空 chunk 的边界：文件大小恰为块大小整数倍时，前端可能发出零字节
    /// 的块（读到文件尾的空 slice）。空块必须走完整协议——base64 解出
    /// 空字节而不是报错、offset==长度 时是合法 no-op、offset 对不上时
    /// 照样被偏移校验拒掉（绝不能因为「反正没写东西」而放行乱序块）。
    #[test]
    fn empty_chunk_respects_offsets_and_preserves_bytes() {
        assert_eq!(
            decode_base64("").as_deref(),
            Ok(&[][..]),
            "空 base64 必须解出空字节而不是被当坏块"
        );

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("askr_import_empty_{nanos}"));
        let staging = dir.join("staging.part");
        let dest = dir.join("promoted.zip");

        // offset 0 的空块是合法开局：落成 0 字节暂存文件。
        append_import_chunk(&staging, 0, b"").expect("空首块必须成功");
        assert_eq!(std::fs::read(&staging).unwrap(), b"");

        // 空块不得绕过偏移校验：长度 0 的暂存收到 offset 3 必须报「中断」。
        let err = append_import_chunk(&staging, 3, b"").expect_err("乱序空块必须被拒绝");
        assert!(err.contains("不连续"), "{err}");

        // 真实场景：有效字节之后跟一个 offset==长度 的零字节收尾块，
        // 内容必须原样保留，转正带走的也必须是这些字节。
        append_import_chunk(&staging, 0, b"zip bytes").expect("重开一轮必须成功");
        append_import_chunk(&staging, 9, b"").expect("offset==长度的空块必须是合法 no-op");
        assert_eq!(std::fs::read(&staging).unwrap(), b"zip bytes");

        promote_import_staging(&staging, &dest).expect("转正必须成功");
        assert_eq!(std::fs::read(&dest).unwrap(), b"zip bytes");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 追加的「查长度 → 写入」必须整体串行：持有 IMPORT_CHUNK_LOCK 期间
    /// 另一个线程的追加既不能落盘也不能通过校验——这正是挡住上一轮
    /// 传输迟到块插队的机制。断言方向是单边安全的：只有追加根本不抢锁
    /// 时才会失败。
    #[test]
    fn append_import_chunk_is_serialized_by_dedicated_mutex() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("askr_import_serial_{nanos}"));
        let staging = dir.join("staging.part");
        append_import_chunk(&staging, 0, b"head").expect("首块必须成功");

        let outer = IMPORT_CHUNK_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let worker_staging = staging.clone();
        let worker = std::thread::spawn(move || append_import_chunk(&worker_staging, 4, b"tail"));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!worker.is_finished(), "持锁期间追加不得完成");
        assert_eq!(
            std::fs::read(&staging).unwrap(),
            b"head",
            "持锁期间暂存文件不得被写入"
        );
        drop(outer);
        worker
            .join()
            .expect("追加线程不该 panic")
            .expect("放锁后排队的追加必须成功");
        assert_eq!(std::fs::read(&staging).unwrap(), b"headtail");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 收尾转正的「确认存在 → 改名」必须整体握着 IMPORT_CHUNK_LOCK：
    /// 持锁期间转正寸步难行，放锁后才允许改名。与
    /// append_import_chunk_is_serialized_by_dedicated_mutex 合起来构成
    /// 互斥的两个方向——追加与转正抢同一把锁，迟到块绝不可能插进
    /// exists 与 rename 之间把字节写进即将转正（或已转正）的文件。
    #[test]
    fn promote_import_staging_is_serialized_with_appends() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("askr_import_promote_{nanos}"));
        let staging = dir.join("staging.part");
        let dest = dir.join("promoted.zip");
        append_import_chunk(&staging, 0, b"complete zip bytes").expect("首块必须成功");

        let outer = IMPORT_CHUNK_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let worker_staging = staging.clone();
        let worker_dest = dest.clone();
        let worker =
            std::thread::spawn(move || promote_import_staging(&worker_staging, &worker_dest));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!worker.is_finished(), "持锁期间转正不得完成");
        assert!(staging.exists(), "持锁期间暂存文件不得被改名走");
        assert!(!dest.exists(), "持锁期间不得出现转正后的文件");
        drop(outer);
        worker
            .join()
            .expect("转正线程不该 panic")
            .expect("放锁后排队的转正必须成功");
        assert!(!staging.exists(), "转正后暂存文件必须消失");
        assert_eq!(
            std::fs::read(&dest).unwrap(),
            b"complete zip bytes",
            "转正必须原封不动地带走全部已落盘字节"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 上一次导入在改名转正之后、finalize 删临时 ZIP 之前崩溃/断电时，
    /// dest 会残留一个弃单（启动清理特意只删 `.part` 不碰它）。Windows
    /// 的 rename 不覆盖已存在的目标：不先删掉弃单，此后每一轮分块导入
    /// 都会在收尾失败且用户无法自救。转正必须清掉残留的 dest 再改名，
    /// 且带走的必须是新一轮的字节。
    #[test]
    fn promote_import_staging_overwrites_leftover_dest() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("askr_import_leftover_{nanos}"));
        let staging = dir.join("staging.part");
        let dest = dir.join("promoted.zip");

        append_import_chunk(&staging, 0, b"fresh transfer bytes").expect("首块必须成功");
        std::fs::write(&dest, b"crashed import leftover").expect("布置弃单必须成功");

        promote_import_staging(&staging, &dest).expect("dest 残留弃单时转正必须成功");
        assert!(!staging.exists(), "转正后暂存文件必须消失");
        assert_eq!(
            std::fs::read(&dest).unwrap(),
            b"fresh transfer bytes",
            "转正必须用新一轮的字节覆盖弃单"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 转正（rename）之后暂存已经不存在：迟到的续传块必须秒拿统一的
    /// 「传输中断」（IMPORT_STREAM_BROKEN）快速失败——既不能把字节写进
    /// 已转正的文件，也不能凭空复活一个幽灵 `.part`。收尾自身在暂存
    /// 缺失时（从未落盘 / 已被中止清理 / 重复收尾）也要报明确的
    /// 「暂存不存在」，而不是含糊的改名 IO 错误。
    #[test]
    fn late_chunk_after_promotion_gets_stream_broken() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("askr_import_late_{nanos}"));
        let staging = dir.join("staging.part");
        let dest = dir.join("promoted.zip");

        append_import_chunk(&staging, 0, b"zip payload").expect("首块必须成功");
        promote_import_staging(&staging, &dest).expect("转正必须成功");

        // 最像真的那种迟到块：偏移恰好等于转正前的长度。
        let err = append_import_chunk(&staging, 11, b" late bytes").expect_err("迟到块必须失败");
        assert!(err.contains("不连续"), "迟到块应得到「中断」话术: {err}");
        assert_eq!(
            std::fs::read(&dest).unwrap(),
            b"zip payload",
            "已转正的文件不得被迟到块污染"
        );
        assert!(!staging.exists(), "迟到块不得复活幽灵 .part");

        let err = promote_import_staging(&staging, &dest).expect_err("暂存缺失时转正必须失败");
        assert!(err.contains("暂存的 ZIP 数据不存在"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// INSTALL_LOCK / IMPORT_TRANSFER_HOLD 都是进程级单例，而 cargo test
    /// 默认并行跑测试；所有触碰它们的测试先拿这把测试专用锁互相串行，
    /// 否则会互相抢锁产生偶发失败。
    static GLOBAL_LOCK_TEST_SERIAL: Mutex<()> = Mutex::new(());

    fn serialize_global_lock_tests() -> std::sync::MutexGuard<'static, ()> {
        GLOBAL_LOCK_TEST_SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 安装互斥的完整生命周期，按顺序写在同一个测试里。
    #[test]
    fn install_lock_serializes_and_always_releases() {
        let _serial = serialize_global_lock_tests();

        // 空闲时首次获取必须成功。
        let guard = acquire_install_lock("sync_data").expect("空闲时获取必须成功");

        // 持锁期间的第二个调用者必须立即得到中文错误（含双方任务名），
        // 而不是排队阻塞。
        let err = acquire_install_lock("import_from_zip").expect_err("持锁期间必须拒绝");
        assert!(
            err.contains("import_from_zip") && err.contains("sync_data"),
            "错误信息应同时指明被拒任务与占用者: {err}"
        );
        assert!(
            err.contains("请等待其完成后再试"),
            "错误信息应给出中文指引: {err}"
        );

        // guard Drop 后锁必须回到空闲态，可被任意任务再次获取。
        drop(guard);
        drop(acquire_install_lock("import_from_zip_bytes").expect("释放后必须可再次获取"));

        // 与真实命令相同的用法：guard move 进阻塞闭包。任务 panic 时
        // unwind 会触发 Drop，锁必须自动释放，不能死锁后续同步。
        let guard = acquire_install_lock("sync_data").expect("上一段结束后锁应空闲");
        let result: Result<(), String> =
            tauri::async_runtime::block_on(run_blocking("sync_data", move || {
                let _guard = guard;
                panic!("模拟解压线程崩溃")
            }));
        assert!(result.is_err(), "panic 应以 Err 浮出");
        drop(acquire_install_lock("sync_data").expect("panic 后锁必须自动释放"));
    }

    /// 弃单判定是纯函数，边界在这里钉死：静默刚满时限即过期，差一秒
    /// 不过期，时钟倒挂按不过期处理（saturating）。
    #[test]
    fn transfer_hold_staleness_boundary() {
        let base = Instant::now();
        assert!(!transfer_hold_is_stale(base, base), "刚落盘的持有不过期");
        assert!(
            !transfer_hold_is_stale(base, base + IMPORT_TRANSFER_STALE - Duration::from_secs(1)),
            "差一秒不过期"
        );
        assert!(
            transfer_hold_is_stale(base, base + IMPORT_TRANSFER_STALE),
            "静默满时限即过期"
        );
        assert!(
            !transfer_hold_is_stale(base + IMPORT_TRANSFER_STALE, base),
            "now 早于 last_chunk_at 时按不过期处理"
        );
    }

    /// 分块传输期间安装互斥的寄存/接力/弃单收尸全流程。
    #[test]
    fn import_transfer_hold_keeps_lock_and_reaps_stale() {
        let _serial = serialize_global_lock_tests();
        // 防御：清掉可能的残留寄存，保证从空闲态开始。
        drop(take_transfer_hold());

        // 首块拿锁后寄存，传输在途时 sync 必须立刻被拒。
        let guard = acquire_install_lock("import_from_zip_bytes").expect("空闲时首块必须拿到锁");
        stow_transfer_hold(guard);
        let err = acquire_install_lock("sync_data").expect_err("传输在途时 sync 必须快速失败");
        assert!(
            err.contains("import_from_zip_bytes"),
            "错误应指明占用者是分块导入: {err}"
        );

        // 续传块取回持有接力；收尾（或失败）放掉后锁恢复空闲。
        let guard = take_transfer_hold().expect("续传块必须能取回寄存的持有");
        assert!(
            take_transfer_hold().is_none(),
            "持有只有一份，取走后寄存处必须为空"
        );
        drop(guard);
        drop(acquire_install_lock("sync_data").expect("持有放掉后锁必须空闲"));

        // 弃单：寄存后长时间无新块，抢锁者必须能把它收走并拿到锁。
        let guard = acquire_install_lock("import_from_zip_bytes").expect("上一段结束后锁应空闲");
        stow_transfer_hold(guard);
        reap_stale_transfer_hold_at(Instant::now() + IMPORT_TRANSFER_STALE);
        assert!(take_transfer_hold().is_none(), "弃单必须已被收走");
        drop(acquire_install_lock("sync_data").expect("弃单收走后 sync 必须能拿到锁"));

        // 新鲜持有绝不能被误杀。
        let guard = acquire_install_lock("import_from_zip_bytes").expect("锁应空闲");
        stow_transfer_hold(guard);
        reap_stale_transfer_hold_at(Instant::now());
        acquire_install_lock("sync_data").expect_err("新鲜持有不该被当弃单收走");
        drop(take_transfer_hold());
    }

    /// 显式中止在途传输：立刻放锁 + 清理暂存，不必等 60 秒弃单超时；
    /// 寄存已空且锁归别人时必须是严格 no-op——既不删文件也不碰别人
    /// 持有的锁。
    #[test]
    fn abort_import_transfer_releases_lock_and_cleans_staging() {
        let _serial = serialize_global_lock_tests();
        // 防御：清掉可能的残留寄存，保证从空闲态开始。
        drop(take_transfer_hold());

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("askr_import_abort_{nanos}"));
        let staging = dir.join("staging.part");

        // 正主中止：传了一半失败，持有寄存在案。中止必须删掉半截
        // 暂存并立刻释放安装互斥——这正是修的那个「点同步要等一分钟」。
        append_import_chunk(&staging, 0, b"half transfer").expect("首块必须成功");
        let guard = acquire_install_lock("import_from_zip_bytes").expect("空闲时必须拿到锁");
        stow_transfer_hold(guard);
        abort_import_transfer(&staging).expect("中止必须成功");
        assert!(!staging.exists(), "中止后半截暂存文件必须被删掉");
        assert!(take_transfer_hold().is_none(), "中止后寄存处必须为空");
        drop(acquire_install_lock("sync_data").expect("中止后 sync 必须立刻拿到锁"));

        // 寄存为空、锁归别人（例如 sync 正在跑）时，中止不得删文件、
        // 不得放掉别人的锁。
        append_import_chunk(&staging, 0, b"someone else's bytes").expect("重建暂存必须成功");
        let others = acquire_install_lock("sync_data").expect("锁应空闲");
        abort_import_transfer(&staging).expect("空寄存时中止必须静默成功");
        assert!(staging.exists(), "没有取到持有就不得删暂存文件");
        acquire_install_lock("import_from_zip").expect_err("别人持有的锁不能被中止放掉");
        drop(others);

        // 暂存文件本就不存在（首块还没落盘就失败）时中止照样成功放锁。
        let guard = acquire_install_lock("import_from_zip_bytes").expect("锁应空闲");
        stow_transfer_hold(guard);
        std::fs::remove_file(&staging).unwrap();
        abort_import_transfer(&staging).expect("暂存缺失时中止必须成功");
        drop(acquire_install_lock("sync_data").expect("锁必须已被释放"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 中途某块在后端失败（解码 / 落盘报错）时 guard 已随 Err 一起
    /// Drop：寄存为空、INSTALL_LOCK 空闲，但半截 `.part` 还躺在盘上。
    /// 显式中止必须现抢一把安装互斥把它删掉，而不是 no-op 留给下次
    /// 启动清理；删完锁必须回到空闲，也不得凭空造出寄存持有。
    #[test]
    fn abort_import_transfer_cleans_staging_when_lock_is_free() {
        let _serial = serialize_global_lock_tests();
        // 防御：清掉可能的残留寄存，保证从空闲态开始。
        drop(take_transfer_hold());

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("askr_import_abort_free_{nanos}"));
        let staging = dir.join("staging.part");

        // 复刻事故现场：首块落盘后，下一块在后端失败——guard 随错误
        // 一起 Drop（未寄存），锁空闲，半截暂存留在盘上。
        append_import_chunk(&staging, 0, b"chunk landed, next one failed").expect("首块必须成功");
        drop(acquire_install_lock("import_from_zip_bytes").expect("空闲时必须拿到锁"));

        abort_import_transfer(&staging).expect("锁空闲时中止必须成功");
        assert!(!staging.exists(), "锁空闲时中止必须删掉遗留的半截暂存");
        assert!(take_transfer_hold().is_none(), "中止不得凭空造出寄存持有");
        drop(acquire_install_lock("sync_data").expect("中止后锁必须回到空闲"));

        // 暂存本就不存在时同样静默成功（幂等），锁照样回到空闲。
        abort_import_transfer(&staging).expect("暂存缺失且锁空闲时中止必须成功");
        drop(acquire_install_lock("sync_data").expect("锁必须仍然空闲"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// cancel 导入之后的迟到块：用户显式中止（cancel=true 分支删掉
    /// `.part` 并放锁）后，滞留在阻塞线程池里的迟到块必须秒拿统一的
    /// 「传输中断」——既不能复活幽灵 `.part` 抵消中止的清理，也不能
    /// 干扰已经空闲的安装互斥。与 late_chunk_after_promotion_gets_
    /// stream_broken 互补：那边钉「收尾转正后」，这边钉「主动取消后」。
    #[test]
    fn late_chunk_after_abort_gets_stream_broken() {
        let _serial = serialize_global_lock_tests();
        // 防御：清掉可能的残留寄存，保证从空闲态开始。
        drop(take_transfer_hold());

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("askr_import_abort_late_{nanos}"));
        let staging = dir.join("staging.part");

        // 传输在途（持有已寄存、半截暂存在盘上）时用户点了取消。
        append_import_chunk(&staging, 0, b"half transfer").expect("首块必须成功");
        let guard = acquire_install_lock("import_from_zip_bytes").expect("空闲时必须拿到锁");
        stow_transfer_hold(guard);
        abort_import_transfer(&staging).expect("中止必须成功");
        assert!(!staging.exists(), "中止后暂存文件必须已被清理");

        // 最像真的迟到块：offset 恰好等于中止前的暂存长度。
        let err =
            append_import_chunk(&staging, 13, b" late bytes").expect_err("中止后的迟到块必须失败");
        assert!(err.contains("不连续"), "迟到块应得到「中断」话术: {err}");
        assert!(!staging.exists(), "迟到块不得复活幽灵 .part");

        // 迟到块的快速失败不得把锁搞脏：sync 必须能立刻拿到。
        drop(acquire_install_lock("sync_data").expect("中止后安装互斥必须保持空闲"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// DataService::new 除记路径外还会尝试接回 `_old` 暂存目录、清理导入
    /// 暂存文件，但对这个不存在的路径它扫不到候选也删不到文件、不会动
    /// 磁盘，所以这里不需要 GameData。
    #[test]
    fn lock_service_recovers_from_poisoned_mutex() {
        let mutex = Arc::new(Mutex::new(DataService::new(PathBuf::from(
            "/nonexistent/askr-lock-poison-test",
        ))));

        let poisoner = Arc::clone(&mutex);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock().unwrap();
            panic!("deliberately poison the mutex");
        })
        .join();

        assert!(mutex.is_poisoned(), "panic 后 Mutex 应处于中毒态");
        // 不应 panic，而是恢复内部数据继续服务。
        let _guard = lock_service(&mutex);
    }
}
