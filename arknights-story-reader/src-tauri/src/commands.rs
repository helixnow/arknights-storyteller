use crate::asset_service::AssetKind;
use crate::data_service::DataService;
use crate::models::{
    Chapter, ParsedStoryContent, SearchDebugResponse, SearchResult, SearchResultsPage,
    SegmentSearchPage, StoryCategory, StoryEntry, StoryIndexStatus, StoryPreviewToken,
};
use crate::parser::parse_story_text;
use std::sync::{Arc, Mutex};
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

/// 读盘 + 解析一整篇剧情，长的有几千行；放到阻塞线程池里，
/// 否则 WebView 每翻一篇就把一个 async worker 占满。
#[tauri::command]
pub async fn get_story_content(
    state: State<'_, AppState>,
    story_path: String,
) -> Result<ParsedStoryContent, String> {
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

/// 把解码后的一块字节追加到暂存文件。`offset == 0` 开新文件（顺带截断
/// 上一轮半途而废的暂存）；其余块要求偏移与暂存文件当前长度严格相等，
/// 乱序 / 串台宁可报错让用户重传，也不能悄悄拼出一个损坏的 ZIP。
fn append_import_chunk(staging: &std::path::Path, offset: u64, chunk: &[u8]) -> Result<(), String> {
    use std::io::Write;

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
/// 拿安装互斥，把暂存文件改名为导入临时 ZIP，走统一导入流程。
#[tauri::command]
pub async fn import_from_zip_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    chunk_base64: String,
    offset: u64,
    last: bool,
) -> Result<(), String> {
    // 只有收尾块真正改写数据目录，需要全程握着安装互斥；首块只探测
    // 一下立刻放掉——纯粹为了快速失败，免得用户传完几百 MB 才被告知
    // 「后台正在同步」。中间的追加只写自己的暂存文件，跟谁都不冲突。
    if offset == 0 && !last {
        drop(acquire_install_lock("import_from_zip_bytes")?);
    }
    let guard = if last {
        Some(acquire_install_lock("import_from_zip_bytes")?)
    } else {
        None
    };
    let service = clone_service(&state);
    run_blocking("import_from_zip_bytes", move || {
        let _guard = guard;
        let chunk = decode_base64(&chunk_base64)?;
        let staging = service.import_staging_path()?;
        append_import_chunk(&staging, offset, &chunk)?;
        if last {
            service.import_zip_from_staging(app)
        } else {
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

    /// 安装互斥的完整生命周期。INSTALL_LOCK 是进程级单例，而 cargo test
    /// 默认并行跑测试，拆成多个 #[test] 会互相抢锁产生偶发失败，
    /// 所以按顺序写在同一个测试里。
    #[test]
    fn install_lock_serializes_and_always_releases() {
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

    /// DataService::new 只记两条路径、不碰磁盘，所以这里不需要 GameData。
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
