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

        /// `(storyName, storyTxt)` for a story id, or the lookup error.
        pub fn story_entry(&self, story_id: &str) -> Result<(String, String), String> {
            self.inner
                .get_story_entry(story_id)
                .map(|entry| (entry.story_name, entry.story_txt))
        }

        pub fn roguelike_group_names(&self) -> Result<Vec<String>, String> {
            Ok(self
                .inner
                .get_roguelike_stories_grouped()?
                .into_iter()
                .map(|(name, _)| name)
                .collect())
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

    let context = tauri::generate_context!();

    // Android 端两个内联移动插件（apk-updater / image-sharer）由 lib.rs 里的
    // `tauri::plugin::Builder` 直接构建，build.rs 没有对应的 InlinedPlugin
    // 权限清单，capabilities/*.json 也因此无法引用它们的权限（引用不存在的
    // 权限会让构建直接失败）。而 Tauri 2 对所有 `plugin:` 前缀的 invoke 都
    // 强制走 ACL：不补授权的话，前端 invoke("plugin:apk-updater|…") /
    // ("plugin:image-sharer|…") 会被一律拒绝——应用内更新、保存到相册、
    // 系统分享在 Android 上整个失效。这里在运行时把所需命令按最小范围
    // 放行：仅 Android 编译、仅本地（Local）来源，窗口约束与
    // capabilities/default.json 的 main 主窗口一致（本应用只有这一个窗口）。
    #[cfg(target_os = "android")]
    let context = {
        use tauri::utils::acl::ExecutionContext;

        let mut context = context;
        let authority = context.runtime_authority_mut();
        for cmd in [
            "plugin:apk-updater|download_and_install",
            "plugin:apk-updater|open_install_permission_settings",
            // @tauri-apps/api 2.11 的 addPluginListener 先试 snake_case，
            // 再以 camelCase 兼容旧移动插件；unregister 固定走 remove_listener。
            "plugin:apk-updater|register_listener",
            "plugin:apk-updater|registerListener",
            "plugin:apk-updater|remove_listener",
            "plugin:image-sharer|save_image",
            "plugin:image-sharer|share_image",
            "plugin:image-sharer|open_storage_permission_settings",
        ] {
            authority.__allow_command(cmd.to_string(), ExecutionContext::Local);
        }
        context
    };

    builder
        .setup(|app| {
            // 解析不出数据目录属于致命配置错误，交给 Tauri 的 setup 错误
            // 通道上报；建目录失败则降级运行——后续每个命令都会把 IO
            // 错误以字符串抛回前端，用户能看到具体原因而不是闪退。
            let app_data_dir = app.path().app_data_dir()?;
            if let Err(err) = std::fs::create_dir_all(&app_data_dir) {
                eprintln!("[SETUP] 创建应用数据目录失败: {}", err);
            }

            let data_service = DataService::new(app_data_dir);

            // 目录解析要读一份数兆的 story_review_table.json；趁 WebView 还在
            // 启动，先在后台把它嚼完，前端第一次拉列表就是缓存命中。
            // 预热纯属优化：线程起不来或预热失败只记日志，绝不阻塞 UI。
            let warmup = data_service.clone();
            if let Err(err) = std::thread::Builder::new()
                .name("catalog-prewarm".into())
                .spawn(move || warmup.prewarm_catalog())
            {
                eprintln!("[SETUP] 目录预热线程启动失败: {}", err);
            }

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
            commands::get_story_preview_token,
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
        ])
        .run(context)
        .expect("error while running tauri application");
}
