use crate::data_service::DataService;
use crate::models::{
    Chapter, ParsedStoryContent, SearchDebugResponse, SearchResult, SearchResultsPage,
    SegmentSearchPage, StoryCategory, StoryEntry, StoryIndexStatus,
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

fn clone_service(state: &State<'_, AppState>) -> DataService {
    let guard = lock_service(&state.data_service);
    let service = guard.clone();
    drop(guard);
    service
}

#[tauri::command]
pub async fn sync_data(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.sync_data(app))
        .await
        .map_err(|err| format!("Failed to join sync task: {}", err))?
}

#[tauri::command]
pub async fn get_current_version(state: State<'_, AppState>) -> Result<String, String> {
    let service = lock_service(&state.data_service);
    service.get_current_version()
}

#[tauri::command]
pub async fn get_remote_version(state: State<'_, AppState>) -> Result<String, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_remote_version())
        .await
        .map_err(|err| format!("Failed to join remote version task: {}", err))?
}

#[tauri::command]
pub async fn check_update(state: State<'_, AppState>) -> Result<bool, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.check_update())
        .await
        .map_err(|err| format!("Failed to join check update task: {}", err))?
}

#[tauri::command]
pub async fn is_installed(state: State<'_, AppState>) -> Result<bool, String> {
    let service = lock_service(&state.data_service);
    Ok(service.is_installed())
}

#[tauri::command]
pub async fn get_chapters(state: State<'_, AppState>) -> Result<Vec<Chapter>, String> {
    let service = lock_service(&state.data_service);
    service.get_chapters()
}

#[tauri::command]
pub async fn get_story_categories(
    state: State<'_, AppState>,
) -> Result<Vec<StoryCategory>, String> {
    let service = lock_service(&state.data_service);
    service.get_story_categories()
}

#[tauri::command]
pub async fn get_story_content(
    state: State<'_, AppState>,
    story_path: String,
) -> Result<ParsedStoryContent, String> {
    let service = lock_service(&state.data_service);
    let content = service.read_story_text(&story_path)?;
    Ok(parse_story_text(&content))
}

#[tauri::command]
pub async fn get_story_info(
    state: State<'_, AppState>,
    info_path: String,
) -> Result<String, String> {
    let service = lock_service(&state.data_service);
    service.read_story_info(&info_path)
}

#[tauri::command]
pub async fn get_story_entry(
    state: State<'_, AppState>,
    story_id: String,
) -> Result<StoryEntry, String> {
    let service = lock_service(&state.data_service);
    service.get_story_entry(&story_id)
}

#[tauri::command]
pub async fn get_story_index_status(
    state: State<'_, AppState>,
) -> Result<StoryIndexStatus, String> {
    let service = lock_service(&state.data_service);
    service.get_story_index_status()
}

#[tauri::command]
pub async fn build_story_index(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.rebuild_story_index_with_progress(&app))
        .await
        .map_err(|err| format!("Failed to join build story index task: {}", err))?
}

#[tauri::command]
pub async fn search_stories(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    let service = lock_service(&state.data_service);
    service.search_stories(&query)
}

#[tauri::command]
pub async fn search_stories_ex(
    state: State<'_, AppState>,
    query: String,
) -> Result<SearchResultsPage, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.search_stories_ex(&query))
        .await
        .map_err(|err| format!("Failed to join search_ex task: {}", err))?
}

#[tauri::command]
pub async fn search_segments(
    state: State<'_, AppState>,
    query: String,
) -> Result<SegmentSearchPage, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.search_segments(&query))
        .await
        .map_err(|err| format!("Failed to join search_segments task: {}", err))?
}

#[tauri::command]
pub async fn search_stories_with_progress(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.search_stories_with_progress(&app, &query))
        .await
        .map_err(|err| format!("Failed to join search with progress task: {}", err))?
}

#[tauri::command]
pub async fn search_stories_debug(
    state: State<'_, AppState>,
    query: String,
) -> Result<SearchDebugResponse, String> {
    let service = lock_service(&state.data_service);
    service.search_stories_with_debug(&query)
}

#[tauri::command]
pub async fn import_from_zip(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.import_zip_from_path(path, app))
        .await
        .map_err(|err| format!("Failed to join import task: {}", err))?
}

#[tauri::command]
pub async fn import_from_zip_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.import_zip_from_bytes(&bytes, app))
        .await
        .map_err(|err| format!("Failed to join import-bytes task: {}", err))?
}

#[tauri::command]
pub async fn get_main_stories_grouped(
    state: State<'_, AppState>,
) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_main_stories_grouped())
        .await
        .map_err(|err| format!("Failed to join main stories grouped task: {}", err))?
}

#[tauri::command]
pub async fn get_activity_stories_grouped(
    state: State<'_, AppState>,
) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_activity_stories_grouped())
        .await
        .map_err(|err| format!("Failed to join activity stories grouped task: {}", err))?
}

#[tauri::command]
pub async fn get_sidestory_stories_grouped(
    state: State<'_, AppState>,
) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_sidestory_stories_grouped())
        .await
        .map_err(|err| format!("Failed to join sidestory stories grouped task: {}", err))?
}

#[tauri::command]
pub async fn get_roguelike_stories_grouped(
    state: State<'_, AppState>,
) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_roguelike_stories_grouped())
        .await
        .map_err(|err| format!("Failed to join roguelike stories grouped task: {}", err))?
}

#[tauri::command]
pub async fn get_memory_stories(state: State<'_, AppState>) -> Result<Vec<StoryEntry>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_memory_stories())
        .await
        .map_err(|err| format!("Failed to join memory stories task: {}", err))?
}

/// 素材 URL 解析：返回一条按优先级排序的候选列表，前端 `<AssetImage>`
/// 依次尝试。不做网络请求，不做缓存（WebView 自己会缓存）。
#[tauri::command]
pub async fn resolve_asset_urls(kind: String, token: String) -> Result<Vec<String>, String> {
    let kind_enum: crate::asset_service::AssetKind = match kind.as_str() {
        "avatar" => crate::asset_service::AssetKind::Avatar,
        "portrait" => crate::asset_service::AssetKind::Portrait,
        "image" => crate::asset_service::AssetKind::Image,
        "background" => crate::asset_service::AssetKind::Background,
        "activity_kv" | "activityKv" => crate::asset_service::AssetKind::ActivityKv,
        "activity_logo" | "activityLogo" => crate::asset_service::AssetKind::ActivityLogo,
        "chapter_cover" | "chapterCover" => crate::asset_service::AssetKind::ChapterCover,
        other => return Err(format!("unknown asset kind: {}", other)),
    };
    Ok(crate::asset_service::resolve(kind_enum, &token))
}

/// 拿到一份干员 name↔charId 快照，前端启动时调用一次并缓存在内存。
#[tauri::command]
pub async fn get_character_index(
    state: State<'_, AppState>,
) -> Result<crate::character_table::CharacterIndex, String> {
    // Best-effort refresh from live data directory if present.
    let path_opt = {
        let guard = lock_service(&state.data_service);
        guard.character_table_path()
    };
    if let Some(path) = path_opt {
        crate::character_table::refresh_from_file(&path);
    }
    Ok(crate::character_table::snapshot())
}

/// 根据 storyId 返回 prev/next 剧情条目（按 storyGroup + storySort 推导）。
#[tauri::command]
pub async fn get_story_neighbors(
    state: State<'_, AppState>,
    story_id: String,
) -> Result<crate::models::StoryNeighbors, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_story_neighbors(&story_id))
        .await
        .map_err(|err| format!("Failed to join neighbors task: {}", err))?
}
