#[cfg(target_os = "android")]
mod apk_updater;
#[cfg(target_os = "android")]
mod image_sharer;
mod asset_service;
mod character_table;
mod commands;
mod data_service;
mod models;
mod parser;

/// Thin test harness exposed for integration tests in `tests/`. Do not use
/// from application code.
#[doc(hidden)]
pub mod data_service_test {
    use std::path::PathBuf;

    use crate::data_service::DataService;
    pub use crate::models::{SearchResultsPage, SegmentSearchPage};

    pub struct DataServiceHandle {
        inner: DataService,
    }

    impl DataServiceHandle {
        pub fn new(app_data_dir: PathBuf) -> Self {
            Self {
                inner: DataService::new(app_data_dir),
            }
        }

        pub fn search_stories_ex(&self, q: &str) -> Result<SearchResultsPage, String> {
            self.inner.search_stories_ex(q)
        }

        pub fn search_segments(&self, q: &str) -> Result<SegmentSearchPage, String> {
            self.inner.search_segments(q)
        }
    }
}

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
