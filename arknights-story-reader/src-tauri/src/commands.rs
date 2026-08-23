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
    let service = clone_service(&state);
    run_blocking("sync_data", move || service.sync_data(app)).await
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
    let service = clone_service(&state);
    run_blocking("import_from_zip", move || {
        service.import_zip_from_path(path, app)
    })
    .await
}

#[tauri::command]
pub async fn import_from_zip_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let service = clone_service(&state);
    run_blocking("import_from_zip_bytes", move || {
        service.import_zip_from_bytes(&bytes, app)
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
