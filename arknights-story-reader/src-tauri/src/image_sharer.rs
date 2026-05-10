#![cfg(target_os = "android")]

//! Android bridge for saving generated images to the gallery or invoking the
//! system share sheet. Talks to `ImageSharerPlugin.kt` via Tauri's mobile
//! plugin API, mirroring the pattern used by `apk_updater.rs`.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginApi, PluginHandle, TauriPlugin},
    Runtime,
};

type PluginResult<T> = Result<T, String>;

const PLUGIN_IDENTIFIER: &str = "com.arknights.storyreader.imagesharer";
const PLUGIN_CLASS: &str = "ImageSharerPlugin";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("image-sharer")
        .invoke_handler(tauri::generate_handler![save_image, share_image, open_storage_permission_settings])
        .setup(|app, api| {
            let sharer = AndroidImageSharer::init(app, api)?;
            app.manage(sharer);
            Ok(())
        })
        .build()
}

#[tauri::command]
async fn save_image<R: Runtime>(
    app: tauri::AppHandle<R>,
    base64: String,
    file_name: Option<String>,
) -> Result<SaveImageResponse, String> {
    let sharer = app.state::<AndroidImageSharer<R>>();
    sharer.save_image(base64, file_name)
}

#[tauri::command]
async fn share_image<R: Runtime>(
    app: tauri::AppHandle<R>,
    base64: String,
    file_name: Option<String>,
    title: Option<String>,
) -> Result<ShareImageResponse, String> {
    let sharer = app.state::<AndroidImageSharer<R>>();
    sharer.share_image(base64, file_name, title)
}

#[tauri::command]
async fn open_storage_permission_settings<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let sharer = app.state::<AndroidImageSharer<R>>();
    sharer.open_storage_permission_settings()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveImageRequest {
    base64: String,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareImageRequest {
    base64: String,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SaveImageResponse {
    #[serde(default)]
    pub saved: bool,
    /// Uri string of the saved media entry (content://), or null when the
    /// save was skipped due to missing permission.
    #[serde(default)]
    pub uri: Option<String>,
    /// When true the caller should prompt the user to grant
    /// `WRITE_EXTERNAL_STORAGE` (Android 9 and below) before retrying.
    #[serde(default)]
    pub needs_permission: bool,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShareImageResponse {
    #[serde(default)]
    pub shared: bool,
}

#[derive(Clone)]
pub struct AndroidImageSharer<R: Runtime>(PluginHandle<R>);

unsafe impl<R: Runtime> Send for AndroidImageSharer<R> {}
unsafe impl<R: Runtime> Sync for AndroidImageSharer<R> {}

impl<R: Runtime> AndroidImageSharer<R> {
    fn init<C: serde::de::DeserializeOwned>(
        _app: &tauri::AppHandle<R>,
        api: PluginApi<R, C>,
    ) -> tauri::Result<Self> {
        let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, PLUGIN_CLASS)?;
        Ok(Self(handle))
    }

    fn save_image(
        &self,
        base64: String,
        file_name: Option<String>,
    ) -> PluginResult<SaveImageResponse> {
        if base64.trim().is_empty() {
            return Err("图片数据为空".to_string());
        }
        let request = SaveImageRequest { base64, file_name };
        self.0
            .run_mobile_plugin("saveImage", request)
            .map_err(|err| err.to_string())
    }

    fn share_image(
        &self,
        base64: String,
        file_name: Option<String>,
        title: Option<String>,
    ) -> PluginResult<ShareImageResponse> {
        if base64.trim().is_empty() {
            return Err("图片数据为空".to_string());
        }
        let request = ShareImageRequest {
            base64,
            file_name,
            title,
        };
        self.0
            .run_mobile_plugin("shareImage", request)
            .map_err(|err| err.to_string())
    }

    fn open_storage_permission_settings(&self) -> PluginResult<()> {
        self.0
            .run_mobile_plugin::<()>("openStoragePermissionSettings", ())
            .map_err(|err| err.to_string())
    }
}
