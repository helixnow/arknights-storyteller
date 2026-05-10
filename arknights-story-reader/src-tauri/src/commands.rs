use crate::data_service::DataService;
use crate::models::{
    Chapter, CharacterAllData, CharacterBasicInfo, CharacterBuildingSkills, CharacterEquipment,
    CharacterHandbook, CharacterHandbookByName, CharacterPotentialRanks, CharacterPotentialToken,
    CharacterSkins, CharacterSkills, CharacterTalents, CharacterTrait, CharacterVoice,
    Furniture, FurnitureSearchResult, FurnitureTheme, ParsedStoryContent, RoguelikeCharm,
    RoguelikeRelic, RoguelikeStage, SearchDebugResponse, SearchResult, SearchResultsPage,
    SegmentSearchPage, StoryCategory, StoryEntry, StoryIndexStatus, SubProfessionInfo,
    TeamPowerInfo,
};
use crate::parser::parse_story_text;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

#[cfg(target_os = "android")]
use sha2::{Sha256, Digest};
#[cfg(target_os = "android")]
use std::io::Read as _;

#[cfg(target_os = "android")]
fn compute_file_sha256(path: &std::path::Path) -> Result<String, String> {
    use std::fs::File;
    let mut file = File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file.read(&mut buffer).map_err(|e| format!("读取文件失败: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidInstallResponse {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub needs_permission: bool,
}

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
pub async fn build_story_index(state: State<'_, AppState>) -> Result<(), String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.rebuild_story_index())
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

#[tauri::command]
pub async fn get_record_stories_grouped(
    state: State<'_, AppState>,
) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_record_stories_grouped())
        .await
        .map_err(|err| format!("Failed to join record stories grouped task: {}", err))?
}

#[tauri::command]
pub async fn get_rune_stories(state: State<'_, AppState>) -> Result<Vec<StoryEntry>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_rune_stories())
        .await
        .map_err(|err| format!("Failed to join rune stories task: {}", err))?
}

#[tauri::command]
pub async fn get_roguelike_charms(
    state: State<'_, AppState>,
) -> Result<Vec<RoguelikeCharm>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_roguelike_charms())
        .await
        .map_err(|err| format!("Failed to join roguelike charms task: {}", err))?
}

#[tauri::command]
pub async fn get_roguelike_relics(
    state: State<'_, AppState>,
) -> Result<Vec<RoguelikeRelic>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_roguelike_relics())
        .await
        .map_err(|err| format!("Failed to join roguelike relics task: {}", err))?
}

#[tauri::command]
pub async fn get_roguelike_stages(
    state: State<'_, AppState>,
) -> Result<Vec<RoguelikeStage>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_roguelike_stages())
        .await
        .map_err(|err| format!("Failed to join roguelike stages task: {}", err))?
}

#[tauri::command]
pub async fn get_characters_list(
    state: State<'_, AppState>,
) -> Result<Vec<CharacterBasicInfo>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_characters_list())
        .await
        .map_err(|err| format!("Failed to join characters list task: {}", err))?
}

#[tauri::command]
pub async fn get_character_handbook(
    state: State<'_, AppState>,
    char_id: String,
) -> Result<CharacterHandbook, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_character_handbook(&char_id))
        .await
        .map_err(|err| format!("Failed to join character handbook task: {}", err))?
}

#[tauri::command]
pub async fn get_character_voices(
    state: State<'_, AppState>,
    char_id: String,
) -> Result<CharacterVoice, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_character_voices(&char_id))
        .await
        .map_err(|err| format!("Failed to join character voices task: {}", err))?
}

#[tauri::command]
pub async fn get_character_equipment(
    state: State<'_, AppState>,
    char_id: String,
) -> Result<CharacterEquipment, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_character_equipment(&char_id))
        .await
        .map_err(|err| format!("Failed to join character equipment task: {}", err))?
}

#[tauri::command]
pub async fn get_character_potential_token(
    state: State<'_, AppState>,
    char_id: String,
) -> Result<CharacterPotentialToken, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_character_potential_token(&char_id))
        .await
        .map_err(|err| format!("Failed to join character potential token task: {}", err))?
}

#[tauri::command]
pub async fn get_character_talents(
    state: State<'_, AppState>,
    char_id: String,
) -> Result<CharacterTalents, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_character_talents(&char_id))
        .await
        .map_err(|err| format!("Failed to join character talents task: {}", err))?
}

#[tauri::command]
pub async fn get_character_trait(
    state: State<'_, AppState>,
    char_id: String,
) -> Result<CharacterTrait, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_character_trait(&char_id))
        .await
        .map_err(|err| format!("Failed to join character trait task: {}", err))?
}

#[tauri::command]
pub async fn get_character_potential_ranks(
    state: State<'_, AppState>,
    char_id: String,
) -> Result<CharacterPotentialRanks, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_character_potential_ranks(&char_id))
        .await
        .map_err(|err| format!("Failed to join character potential ranks task: {}", err))?
}

#[tauri::command]
pub async fn get_character_skills(
    state: State<'_, AppState>,
    char_id: String,
) -> Result<CharacterSkills, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_character_skills(&char_id))
        .await
        .map_err(|err| format!("Failed to join character skills task: {}", err))?
}

#[tauri::command]
pub async fn get_character_skins(
    state: State<'_, AppState>,
    char_id: String,
) -> Result<CharacterSkins, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_character_skins(&char_id))
        .await
        .map_err(|err| format!("Failed to join character skins task: {}", err))?
}

#[tauri::command]
pub async fn get_sub_profession_info(
    state: State<'_, AppState>,
    sub_prof_id: String,
) -> Result<SubProfessionInfo, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_sub_profession_info(&sub_prof_id))
        .await
        .map_err(|err| format!("Failed to join sub profession info task: {}", err))?
}

#[tauri::command]
pub async fn get_team_power_info(
    state: State<'_, AppState>,
    power_id: String,
) -> Result<TeamPowerInfo, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_team_power_info(&power_id))
        .await
        .map_err(|err| format!("Failed to join team power info task: {}", err))?
}

#[tauri::command]
pub async fn get_character_building_skills(
    state: State<'_, AppState>,
    char_id: String,
) -> Result<CharacterBuildingSkills, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_character_building_skills(&char_id))
        .await
        .map_err(|err| format!("Failed to join character building skills task: {}", err))?
}

#[tauri::command]
pub async fn get_character_all_data(
    state: State<'_, AppState>,
    char_id: String,
) -> Result<CharacterAllData, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_character_all_data(&char_id))
        .await
        .map_err(|err| format!("Failed to join character all data task: {}", err))?
}

// ==================== Android Update Methods (Multi-fallback) ====================

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_update_method1_plugin_direct(
    app: AppHandle,
    url: String,
    file_name: Option<String>,
) -> Result<AndroidInstallResponse, String> {
    use tauri::Manager;
    let updater = app.state::<crate::apk_updater::AndroidUpdater<tauri::Wry>>();
    updater
        .download_and_install(url, file_name)
        .map(|res| AndroidInstallResponse {
            status: res.status,
            needs_permission: res.needs_permission,
        })
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_update_method2_http_download(
    app: AppHandle,
    url: String,
    file_name: Option<String>,
    expected_sha256: Option<String>,
) -> Result<AndroidInstallResponse, String> {
    // Wrap blocking HTTP + filesystem in a blocking task to avoid stalling async runtime/UI
    tauri::async_runtime::spawn_blocking(move || {
        use std::fs::File;
        use std::io::Write;
        use tauri::Manager;

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

        let response = client
            .get(&url)
            .send()
            .map_err(|e| format!("下载请求失败: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("服务器返回错误: HTTP {}", response.status()));
        }

        let bytes = response
            .bytes()
            .map_err(|e| format!("读取响应失败: {}", e))?;

        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("获取缓存目录失败: {}", e))?;
        std::fs::create_dir_all(&cache_dir).map_err(|e| format!("创建缓存目录失败: {}", e))?;

        let file_name =
            file_name.unwrap_or_else(|| format!("update-{}.apk", chrono::Utc::now().timestamp()));
        let apk_path = cache_dir.join(&file_name);

        let mut file = File::create(&apk_path).map_err(|e| format!("创建 APK 文件失败: {}", e))?;
        file.write_all(&bytes)
            .map_err(|e| format!("写入 APK 文件失败: {}", e))?;
        drop(file);

        // 如果提供了 SHA-256 校验和，则验证文件完整性
        if let Some(expected) = expected_sha256.as_ref() {
            let expected_lower = expected.trim().to_lowercase();
            if !expected_lower.is_empty() {
                let actual = compute_file_sha256(&apk_path)?;
                if actual != expected_lower {
                    // 校验失败，删除文件并返回用户友好的错误
                    let _ = std::fs::remove_file(&apk_path);
                    return Err(format!(
                        "下载的安装包可能已损坏或被篡改，请重新下载。\n\n技术详情：SHA-256 校验失败\n期望: {}\n实际: {}",
                        expected_lower, actual
                    ));
                }
            }
        }

        install_apk_via_intent(app, apk_path)
    })
    .await
    .map_err(|err| format!("Failed to join android http download task: {}", err))?
}

#[cfg(target_os = "android")]
fn install_apk_via_intent(
    app: AppHandle,
    apk_path: std::path::PathBuf,
) -> Result<AndroidInstallResponse, String> {
    use tauri::Manager;

    let path_str = apk_path.to_string_lossy().to_string();

    // Try plugin's install helper if available
    if let Some(_updater) = app.try_state::<crate::apk_updater::AndroidUpdater<tauri::Wry>>() {
        // Try to use native plugin to trigger install
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // This would need additional helper in plugin, skip for now
            Err::<AndroidInstallResponse, String>("Plugin install helper not implemented".into())
        }));
        if let Ok(Ok(response)) = result {
            return Ok(response);
        }
    }

    // Return path for frontend to handle
    Ok(AndroidInstallResponse {
        status: Some(format!("downloaded:{}", path_str)),
        needs_permission: false,
    })
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_update_method3_frontend_download(app: AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("获取缓存目录失败: {}", e))?;
    Ok(cache_dir.to_string_lossy().to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_update_method4_install_from_path(
    _app: AppHandle,
    apk_path: String,
) -> Result<AndroidInstallResponse, String> {
    // This would require JNI bridge to call Android PackageInstaller
    // For now, return needs_permission to let user manually install
    Ok(AndroidInstallResponse {
        status: Some(format!("manual_install_required:{}", apk_path)),
        needs_permission: true,
    })
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_open_install_permission_settings(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(updater) = app.try_state::<crate::apk_updater::AndroidUpdater<tauri::Wry>>() {
        updater.open_install_permission_settings()
    } else {
        Err("APK updater plugin not available".into())
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_update_method1_plugin_direct(
    _app: AppHandle,
    _url: String,
    _file_name: Option<String>,
) -> Result<AndroidInstallResponse, String> {
    Err("Not Android platform".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_update_method2_http_download(
    _app: AppHandle,
    _url: String,
    _file_name: Option<String>,
    _expected_sha256: Option<String>,
) -> Result<AndroidInstallResponse, String> {
    Err("Not Android platform".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_update_method3_frontend_download(_app: AppHandle) -> Result<String, String> {
    Err("Not Android platform".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_update_method4_install_from_path(
    _app: AppHandle,
    _apk_path: String,
) -> Result<AndroidInstallResponse, String> {
    Err("Not Android platform".into())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_open_install_permission_settings(_app: AppHandle) -> Result<(), String> {
    Err("Not Android platform".into())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_save_apk_to_downloads(
    app: AppHandle,
    source_file_path: String,
    file_name: String,
) -> Result<crate::apk_updater::SaveToDownloadsResponse, String> {
    use tauri::Manager;
    let updater = app.state::<crate::apk_updater::AndroidUpdater<tauri::Wry>>();
    updater.save_apk_to_downloads(source_file_path, file_name)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn android_save_apk_to_downloads(
    _app: AppHandle,
    _source_file_path: String,
    _file_name: String,
) -> Result<crate::apk_updater::SaveToDownloadsResponse, String> {
    Err("Not Android platform".into())
}

// ==================== 家具相关命令 ====================

#[tauri::command]
pub async fn get_all_furnitures(state: State<'_, AppState>) -> Result<Vec<Furniture>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_all_furnitures())
        .await
        .map_err(|err| format!("Failed to get furnitures: {}", err))?
}

#[tauri::command]
pub async fn get_furnitures_by_theme(
    state: State<'_, AppState>,
    theme_id: String,
) -> Result<Vec<Furniture>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_furnitures_by_theme(&theme_id))
        .await
        .map_err(|err| format!("Failed to get furnitures by theme: {}", err))?
}

#[tauri::command]
pub async fn search_furnitures(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<FurnitureSearchResult>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.search_furnitures(&query))
        .await
        .map_err(|err| format!("Failed to search furnitures: {}", err))?
}

#[tauri::command]
pub async fn get_furniture_themes(
    state: State<'_, AppState>,
) -> Result<Vec<FurnitureTheme>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_furniture_themes())
        .await
        .map_err(|err| format!("Failed to get furniture themes: {}", err))?
}

// ==================== 干员密录通过名字查询 ====================

#[tauri::command]
pub async fn get_character_handbook_by_name(
    state: State<'_, AppState>,
    char_name: String,
) -> Result<CharacterHandbookByName, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_character_handbook_by_name(&char_name))
        .await
        .map_err(|err| format!("Failed to get character handbook by name: {}", err))?
}

#[tauri::command]
pub async fn get_character_handbooks_by_names(
    state: State<'_, AppState>,
    char_names: Vec<String>,
) -> Result<Vec<CharacterHandbookByName>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || {
        service.get_character_handbooks_by_names(char_names)
    })
    .await
    .map_err(|err| format!("Failed to get character handbooks by names: {}", err))?
}

// ==================== Main 分支独有功能 ====================

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

/// 返回 storyId 所在的章节 / 活动显示名（例如 "黑暗时代·上"）。
#[tauri::command]
pub async fn get_story_category_name(
    state: State<'_, AppState>,
    story_id: String,
) -> Result<Option<String>, String> {
    let service = clone_service(&state);
    tauri::async_runtime::spawn_blocking(move || service.get_story_category_name(&story_id))
        .await
        .map_err(|err| format!("Failed to join category name task: {}", err))?
}
