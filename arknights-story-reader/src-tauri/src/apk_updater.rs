#![cfg(target_os = "android")]

//! Android 端 APK 自更新桥接。
//!
//! 通过 Tauri mobile plugin API 调用 `ApkUpdaterPlugin.kt` 完成下载与安装。
//! 桌面端不编译本模块（lib.rs 按 target gate），更新走各自的发布渠道。
//!
//! 加固要点：
//! - 插件注册失败时 `try_state` 返回明确错误，而不是 `state()` panic；
//! - 下载地址只接受 http(s)，文件名拒绝路径穿越；
//! - 日志只在 debug 构建输出，且 URL 一律去掉 query/fragment
//!   （下载直链的参数里常带临时签名），release 不打任何日志；
//! - 原生层回显的错误信息在返回前端前同样做 URL 脱敏。

use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{
    plugin::{Builder, PluginApi, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

type PluginResult<T> = Result<T, String>;

const PLUGIN_IDENTIFIER: &str = "com.arknights.storyreader.updater";
const PLUGIN_CLASS: &str = "ApkUpdaterPlugin";

/// 插件 state 缺失（原生注册失败）时给前端的提示。
const STATE_MISSING_ERROR: &str = "更新组件未初始化（原生插件注册失败），请重启应用后再试";
const DOWNLOAD_IN_FLIGHT_ERROR: &str = "已有更新下载正在进行，请等待完成后再试";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apk-updater")
        .invoke_handler(tauri::generate_handler![
            download_and_install,
            open_install_permission_settings
        ])
        .setup(|app, api| {
            // 注册失败时不要把错误往上抛：插件 setup 返回 Err 会让整个
            // Tauri 应用启动失败（lib.rs 的 run().expect 直接 panic 闪退），
            // 用户连剧情都读不了。这里只是不 manage 状态，后续命令经
            // try_state 拿不到句柄时返回 STATE_MISSING_ERROR——这正是
            // 文件头承诺的降级路径（与 image_sharer.rs 的处理一致）。
            match AndroidUpdater::init(app, api) {
                Ok(updater) => {
                    app.manage(updater);
                }
                Err(_err) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[apk-updater] 注册 Android 插件失败：{_err}");
                }
            }
            Ok(())
        })
        .build()
}

#[tauri::command]
async fn download_and_install<R: Runtime>(
    app: tauri::AppHandle<R>,
    url: String,
    file_name: Option<String>,
) -> Result<DownloadResponse, String> {
    let updater = app
        .try_state::<AndroidUpdater<R>>()
        .ok_or_else(|| STATE_MISSING_ERROR.to_string())?;
    updater.download_and_install(url, file_name).await
}

#[tauri::command]
async fn open_install_permission_settings<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let updater = app
        .try_state::<AndroidUpdater<R>>()
        .ok_or_else(|| STATE_MISSING_ERROR.to_string())?;
    updater.open_install_permission_settings().await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadRequest {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResponse {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub needs_permission: bool,
}

/// 校验下载地址：仅接受 http(s)。错误信息不回显 URL 本身，
/// 避免带签名 token 的链接被前端日志/错误上报带出去。
fn validate_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("更新地址为空，请稍后重试或前往发布页手动下载".to_string());
    }
    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|_| "更新地址无效：仅支持完整的 http/https 链接".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("更新地址无效：仅支持 http/https 链接".to_string());
    }
    // Basic-auth 凭据会出现在 authority（https://user:pass@host），不属于
    // query/fragment；旧的日志/错误脱敏只截后两者，会把密码原样带出去。
    // 更新直链没有使用 URL userinfo 的合理场景，入口直接拒绝。
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("更新地址无效：链接不得包含用户名或密码".to_string());
    }
    Ok(trimmed.to_string())
}

/// 规范化落盘文件名：空白视为未提供；含路径分隔符或 `..` 的
/// 一律拒绝，防止原生层把 APK 写到意料之外的位置。
fn sanitize_file_name(file_name: Option<String>) -> Result<Option<String>, String> {
    let Some(name) = file_name else {
        return Ok(None);
    };
    let name = name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains('\0') {
        return Err("更新文件名无效".to_string());
    }
    Ok(Some(name.to_string()))
}

/// 找到字符串里下一个 http(s) 链接的起点。
fn find_url_start(s: &str) -> Option<usize> {
    let folded = s.to_ascii_lowercase();
    match (folded.find("http://"), folded.find("https://")) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// 把文本中内嵌的 http(s) 链接截断到 query/fragment 之前。原生层
/// 抛出的异常信息经常会回显完整下载直链，这里统一脱敏后再返回前端。
fn scrub_url_secrets(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(start) = find_url_start(rest) {
        let (before, url_and_tail) = rest.split_at(start);
        out.push_str(before);
        let url_end = url_and_tail
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
            .unwrap_or(url_and_tail.len());
        let (url, tail) = url_and_tail.split_at(url_end);
        let cut = url.find(|c| c == '?' || c == '#').unwrap_or(url.len());
        out.push_str(&url[..cut]);
        rest = tail;
    }
    out.push_str(rest);
    out
}

/// debug 日志专用的脱敏 URL（只保留 scheme + host + path）。
#[cfg(debug_assertions)]
fn redacted_url(url: &str) -> &str {
    let end = url.find(|c| c == '?' || c == '#').unwrap_or(url.len());
    &url[..end]
}

#[derive(Debug)]
struct DownloadPermit(Arc<AtomicBool>);

impl Drop for DownloadPermit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn acquire_download(gate: &Arc<AtomicBool>) -> PluginResult<DownloadPermit> {
    gate.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| DownloadPermit(Arc::clone(gate)))
        .map_err(|_| DOWNLOAD_IN_FLIGHT_ERROR.to_string())
}

#[derive(Clone)]
pub struct AndroidUpdater<R: Runtime> {
    handle: PluginHandle<R>,
    download_in_flight: Arc<AtomicBool>,
}

impl<R: Runtime> AndroidUpdater<R> {
    fn init<C: serde::de::DeserializeOwned>(
        _app: &tauri::AppHandle<R>,
        api: PluginApi<R, C>,
    ) -> tauri::Result<Self> {
        let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, PLUGIN_CLASS)?;
        Ok(Self {
            handle,
            download_in_flight: Arc::new(AtomicBool::new(false)),
        })
    }

    /// 用 `run_mobile_plugin_async` 而不是同步的 `run_mobile_plugin`：
    /// 后者在 `std::sync::mpsc::recv()` 上挂起调用线程直到 Kotlin resolve，
    /// 而 APK 下载动辄数分钟——这条 async command 跑在 Tauri 的 tokio
    /// runtime 上，同步等待会把一个 worker 线程扣住整个下载时长，用户
    /// 边下边读剧情时其余 invoke 全都在同一个池上排队。
    async fn download_and_install(
        &self,
        url: String,
        file_name: Option<String>,
    ) -> PluginResult<DownloadResponse> {
        let url = validate_url(&url)?;
        let file_name = sanitize_file_name(file_name)?;
        // Kotlin 侧也有最后一道 compareAndSet；Rust 侧先拒绝可以避免第二条
        // 长任务跨 JNI 排队，并保证未来替换原生实现时互斥语义不会丢。
        let _permit = acquire_download(&self.download_in_flight)?;

        #[cfg(debug_assertions)]
        eprintln!("[apk-updater] downloading {}", redacted_url(&url));

        let request = DownloadRequest { url, file_name };
        self.handle
            .run_mobile_plugin_async("downloadAndInstall", request)
            .await
            .map_err(|err| {
                #[cfg(debug_assertions)]
                eprintln!(
                    "[apk-updater] downloadAndInstall failed: {}",
                    scrub_url_secrets(&err.to_string())
                );
                format!(
                    "下载或安装更新失败：{}",
                    scrub_url_secrets(&err.to_string())
                )
            })
    }

    async fn open_install_permission_settings(&self) -> PluginResult<()> {
        self.handle
            .run_mobile_plugin_async::<()>("openInstallPermissionSettings", ())
            .await
            .map_err(|err| {
                #[cfg(debug_assertions)]
                eprintln!("[apk-updater] openInstallPermissionSettings failed: {err}");
                format!(
                    "无法打开安装权限设置：{}",
                    scrub_url_secrets(&err.to_string())
                )
            })
    }
}

// 仅在 Android target 下编译（见文件顶部的 `#![cfg]`），`cargo test --lib`
// 在桌面端不会跑到这里；纯函数测试保留下来供 Android 侧 CI 使用。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_url_accepts_http_and_https_only() {
        assert!(validate_url("https://example.com/app.apk").is_ok());
        assert!(validate_url("  http://example.com/app.apk  ").is_ok());
        assert!(validate_url("HTTPS://EXAMPLE.COM/app.apk?signature=secret").is_ok());
        assert!(validate_url("").is_err());
        assert!(validate_url("   ").is_err());
        assert!(validate_url("https://").is_err());
        assert!(validate_url("https:///app.apk").is_err());
        assert!(validate_url("https://exa mple.com/app.apk").is_err());
        assert!(validate_url("ftp://example.com/app.apk").is_err());
        assert!(validate_url("file:///sdcard/app.apk").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url("https://user@example.com/app.apk").is_err());
        assert!(validate_url("https://user:secret@example.com/app.apk").is_err());
    }

    #[test]
    fn sanitize_file_name_rejects_path_traversal() {
        assert_eq!(sanitize_file_name(None), Ok(None));
        assert_eq!(sanitize_file_name(Some("   ".into())), Ok(None));
        assert_eq!(
            sanitize_file_name(Some(" update.apk ".into())),
            Ok(Some("update.apk".to_string()))
        );
        assert!(sanitize_file_name(Some("../evil.apk".into())).is_err());
        assert!(sanitize_file_name(Some("a/b.apk".into())).is_err());
        assert!(sanitize_file_name(Some("a\\b.apk".into())).is_err());
        assert!(sanitize_file_name(Some("a\0b.apk".into())).is_err());
    }

    #[test]
    fn scrub_url_secrets_strips_query_and_fragment() {
        assert_eq!(
            scrub_url_secrets("failed: https://cdn.example.com/app.apk?token=SECRET after"),
            "failed: https://cdn.example.com/app.apk after"
        );
        assert_eq!(
            scrub_url_secrets("a http://x/y#frag b https://z/w?k=v"),
            "a http://x/y b https://z/w"
        );
        assert_eq!(scrub_url_secrets("no urls here"), "no urls here");
        assert_eq!(scrub_url_secrets(""), "");
    }

    #[test]
    fn scrub_url_secrets_is_case_insensitive() {
        assert_eq!(
            scrub_url_secrets(
                "failed HTTPS://CDN.EXAMPLE/app.apk?X-Amz-Signature=SECRET and Http://x/y#token"
            ),
            "failed HTTPS://CDN.EXAMPLE/app.apk and Http://x/y"
        );
        assert_eq!(
            redacted_url("HTTPS://CDN.EXAMPLE/app.apk?X-Amz-Signature=SECRET"),
            "HTTPS://CDN.EXAMPLE/app.apk"
        );
    }

    #[test]
    fn concurrent_download_gate_rejects_then_recovers() {
        let gate = Arc::new(AtomicBool::new(false));
        let first = acquire_download(&gate).expect("first download should acquire");
        let err = acquire_download(&gate).expect_err("second download must be rejected");
        assert_eq!(err, DOWNLOAD_IN_FLIGHT_ERROR);
        drop(first);
        assert!(
            acquire_download(&gate).is_ok(),
            "gate must reopen after completion or cancellation"
        );
    }
}
