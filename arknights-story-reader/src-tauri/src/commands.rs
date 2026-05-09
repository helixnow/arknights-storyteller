use crate::data_service::DataService;
use crate::models::{
    Chapter, ParsedStoryContent, SearchDebugResponse, SearchResult, SearchResultsPage,
    StoryCategory, StoryEntry, StoryIndexStatus,
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
