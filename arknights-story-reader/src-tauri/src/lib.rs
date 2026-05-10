mod commands;
mod data_service;
mod models;
mod parser;
mod asset_service;
mod character_table;

#[cfg(target_os = "android")]
mod apk_updater;
#[cfg(target_os = "android")]
mod image_sharer;

use commands::AppState;
use data_service::DataService;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(not(target_os = "android"))]
    {
        builder = builder.plugin(tauri_plugin_opener::init());
        builder = builder.plugin(tauri_plugin_dialog::init());
        builder = builder.plugin(tauri_plugin_process::init());
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(crate::apk_updater::init());
        builder = builder.plugin(crate::image_sharer::init());
    }

    builder
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");

            std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data directory");

            let data_service = DataService::new(app_data_dir);

            app.manage(AppState {
                data_service: Arc::new(Mutex::new(data_service)),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::sync_data,
            commands::get_current_version,
            commands::get_remote_version,
            commands::check_update,
            commands::is_installed,
            commands::get_main_stories_grouped,
            commands::get_activity_stories_grouped,
            commands::get_sidestory_stories_grouped,
            commands::get_roguelike_stories_grouped,
            commands::get_memory_stories,
            commands::get_record_stories_grouped,
            commands::get_rune_stories,
            commands::get_roguelike_charms,
            commands::get_roguelike_relics,
            commands::get_roguelike_stages,
            commands::get_characters_list,
            commands::get_character_handbook,
            commands::get_character_voices,
            commands::get_character_equipment,
            commands::get_character_potential_token,
            commands::get_character_talents,
            commands::get_character_trait,
            commands::get_character_potential_ranks,
            commands::get_character_skills,
            commands::get_character_skins,
            commands::get_sub_profession_info,
            commands::get_team_power_info,
            commands::get_character_building_skills,
            commands::get_character_all_data,
            commands::import_from_zip,
            commands::import_from_zip_bytes,
            commands::get_chapters,
            commands::get_story_categories,
            commands::get_story_content,
            commands::get_story_info,
            commands::get_story_entry,
            commands::get_story_index_status,
            commands::build_story_index,
            commands::search_stories,
            commands::search_stories_ex,
            commands::search_segments,
            commands::search_stories_with_progress,
            commands::search_stories_debug,
            commands::resolve_asset_urls,
            commands::get_character_index,
            commands::get_story_neighbors,
            commands::get_story_category_name,
            commands::android_update_method1_plugin_direct,
            commands::android_update_method2_http_download,
            commands::android_update_method3_frontend_download,
            commands::android_update_method4_install_from_path,
            commands::android_open_install_permission_settings,
            commands::android_save_apk_to_downloads,
            // 家具相关命令
            commands::get_all_furnitures,
            commands::get_furnitures_by_theme,
            commands::search_furnitures,
            commands::get_furniture_themes,
            // 干员密录通过名字查询
            commands::get_character_handbook_by_name,
            commands::get_character_handbooks_by_names,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
