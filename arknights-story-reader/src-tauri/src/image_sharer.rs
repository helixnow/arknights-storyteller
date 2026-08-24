#![cfg(target_os = "android")]

//! Android bridge for saving generated images to the gallery or invoking the
//! system share sheet. Talks to `ImageSharerPlugin.kt` via Tauri's mobile
//! plugin API, mirroring the pattern used by `apk_updater.rs`.
//!
//! 这一层刻意做成"过滤器"而不是纯转发：跨 JNI 之后所有错误都会退化成
//! Kotlin 抛出的异常字符串（经常只有一句 `null`），用户根本看不懂。
//! 所以能在 Rust 侧判定的坏输入——空数据、被截断的 base64、带路径分隔符
//! 的文件名——都在这里挡下来，并换成一句能指导下一步操作的中文提示。

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginApi, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

type PluginResult<T> = Result<T, String>;

const PLUGIN_IDENTIFIER: &str = "com.arknights.storyreader.imagesharer";
const PLUGIN_CLASS: &str = "ImageSharerPlugin";

/// 插件没注册成功时所有命令共用的提示。宁可让分享功能单独失败，也不能
/// 让整个 app 因为一个可选能力起不来（见 [`init`]）。
const NOT_READY_MESSAGE: &str = "图片分享组件未就绪（Android 插件未加载），请重启应用后再试";

/// base64 载荷的上下限。上限按"1080×16384 的 PNG"留足余量：再大的图
/// Kotlin 侧 `Base64.decode` 出来的 ByteArray 也很可能直接 OOM，早点在
/// Rust 侧给一句能指导操作的提示，比在 JNI 里崩掉强。
const MAX_BASE64_BYTES: usize = 32 * 1024 * 1024;
/// 一张最小的合法 PNG 编码后也有百来字节，比这更短一定是坏数据。
const MIN_BASE64_BYTES: usize = 64;
/// 文件名主干的最大字符数（不含 `.png`）。MediaStore 的 DISPLAY_NAME 在
/// 部分 ROM 上有长度限制，剧情标题又可能很长，统一截断。
const MAX_FILE_NAME_CHARS: usize = 80;
/// 分享面板标题的最大字符数，超出部分系统 chooser 本来也会省略。
const MAX_TITLE_CHARS: usize = 120;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("image-sharer")
        .invoke_handler(tauri::generate_handler![
            save_image,
            share_image,
            open_storage_permission_settings
        ])
        .setup(|app, api| {
            // 注册失败时不要把错误往上抛：插件 setup 返回 Err 会让整个
            // Tauri 应用启动失败，用户连剧情都读不了。这里只是不 manage
            // 状态，后续每条命令都会返回 NOT_READY_MESSAGE。
            match AndroidImageSharer::init(app, api) {
                Ok(sharer) => {
                    app.manage(sharer);
                }
                Err(_err) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[image-sharer] 注册 Android 插件失败：{_err}");
                }
            }
            Ok(())
        })
        .build()
}

/// 取出已注册的插件句柄。用 `try_state` 而不是 `state`——后者在状态缺失
/// 时是 `panic!`，而"插件没注册"恰恰是 [`init`] 会容忍的正常分支。
fn sharer<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> PluginResult<tauri::State<'_, AndroidImageSharer<R>>> {
    app.try_state::<AndroidImageSharer<R>>()
        .ok_or_else(|| NOT_READY_MESSAGE.to_string())
}

#[tauri::command]
async fn save_image<R: Runtime>(
    app: tauri::AppHandle<R>,
    base64: String,
    file_name: Option<String>,
) -> Result<SaveImageResponse, String> {
    let payload = normalize_base64_payload(&base64)?;
    let file_name = sanitize_png_file_name(file_name.as_deref());
    sharer(&app)?.save_image(payload, file_name).await
}

#[tauri::command]
async fn share_image<R: Runtime>(
    app: tauri::AppHandle<R>,
    base64: String,
    file_name: Option<String>,
    title: Option<String>,
) -> Result<ShareImageResponse, String> {
    let payload = normalize_base64_payload(&base64)?;
    let file_name = sanitize_png_file_name(file_name.as_deref());
    let title = sanitize_share_title(title.as_deref());
    sharer(&app)?.share_image(payload, file_name, title).await
}

#[tauri::command]
async fn open_storage_permission_settings<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    sharer(&app)?.open_storage_permission_settings().await
}

/// 归一化 `data:image/png;base64,...` / 裸 base64，顺带做完整性体检。
///
/// Kotlin 侧的 `decodeBase64` 只会 `substringAfter(',')` 再交给
/// `Base64.decode`，任何空白字符或截断都会变成一句 `bad base64` 异常。
/// 在这里压成紧凑串并给出可读原因，前端就能直接把消息弹给用户。
fn normalize_base64_payload(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("图片数据为空，请重新生成后再试".to_string());
    }

    let body = if trimmed
        .get(.."data:".len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
    {
        let rest = &trimmed["data:".len()..];
        let Some((metadata, payload)) = rest.split_once(',') else {
            return Err("图片数据不是 base64 编码的 PNG，请重新生成".to_string());
        };
        let mut parts = metadata.split(';').map(str::trim);
        let is_png = parts
            .next()
            .is_some_and(|mime| mime.eq_ignore_ascii_case("image/png"));
        let is_base64 = parts.any(|part| part.eq_ignore_ascii_case("base64"));
        // 不能只看 `base64,`：data:image/jpeg;base64 也能解码，但随后会被
        // 以 `.png` / image/png 写进 MediaStore，得到扩展名与内容不符的坏图。
        if !is_png || !is_base64 {
            return Err("图片数据不是 base64 编码的 PNG，请重新生成".to_string());
        }
        payload
    } else {
        trimmed
    };

    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.len() < MIN_BASE64_BYTES {
        return Err("图片数据不完整，请重新生成后再试".to_string());
    }
    if compact.len() > MAX_BASE64_BYTES {
        return Err(format!(
            "图片过大（约 {} MB），请减少选中的段落后再试",
            compact.len() / (1024 * 1024)
        ));
    }
    // 合法的 base64 总是 4 的倍数，且 `=` 只能在末尾出现一到两次。旧校验
    // 只看字符集合，会放过中间带 padding 的串，Kotlin 到解码时才失败。
    if !has_valid_base64_shape(&compact) {
        return Err("图片数据已损坏，请重新生成后再试".to_string());
    }
    // 所有 PNG 都以固定的 8 字节签名开头，其 base64 前缀恒为这一串。
    // 不用引入整套解码依赖也能挡住 JPEG/SVG/任意字节冒充 PNG。
    if !compact.starts_with("iVBORw0KGgo") {
        return Err("图片数据已损坏，请重新生成后再试".to_string());
    }
    Ok(compact)
}

fn has_valid_base64_shape(value: &str) -> bool {
    if value.len() % 4 != 0 || !value.chars().all(is_base64_symbol) {
        return false;
    }
    let padding = value.bytes().rev().take_while(|byte| *byte == b'=').count();
    padding <= 2 && !value[..value.len() - padding].contains('=')
}

fn is_base64_symbol(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=')
}

/// 收敛导出文件名，规则和 `src/hooks/useImageSharer.ts` 的
/// `normalizePngFileName` 对齐：相册、系统分享两条落盘路径拿到同一份名字。
///
/// 返回 `None` 表示"没有可用名字"，交给 Kotlin 的
/// `defaultFileName()` 生成带时间戳的唯一名，比在这里硬塞一个固定
/// `story.png` 更不容易在相册里互相覆盖。
fn sanitize_png_file_name(raw: Option<&str>) -> Option<String> {
    let candidate = raw?.trim();
    if candidate.is_empty() {
        return None;
    }

    // 只保留最后一段路径。`../../../evil.png` 不能穿出 Kotlin 侧的分享
    // 缓存目录，也不能污染 MediaStore 的 RELATIVE_PATH。
    let base = candidate.rsplit(['/', '\\']).next().unwrap_or_default();
    let replaced: String = base
        .chars()
        .map(|c| if is_forbidden_name_char(c) { '_' } else { c })
        .collect();

    // 先摘后缀再修剪：`.png` 这种"只有后缀没有主干"的输入必须落到 None，
    // 反过来先修剪就会把点吃掉、拼出一个荒唐的 `png.png`。
    // `is_char_boundary` 是必要的——末尾是三字节汉字时 `len - 4` 会落在
    // 字符中间，直接切片就是一次 panic。
    let stem = if replaced.len() >= 4
        && replaced.is_char_boundary(replaced.len() - 4)
        && replaced[replaced.len() - 4..].eq_ignore_ascii_case(".png")
    {
        &replaced[..replaced.len() - 4]
    } else {
        replaced.as_str()
    };

    // 前导点会变成隐藏文件；尾部的点和空格在部分文件系统上会被静默吃掉。
    let stem = stem.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if stem.is_empty() {
        return None;
    }

    let clipped: String = stem.chars().take(MAX_FILE_NAME_CHARS).collect();
    // 截断可能又在尾部留下点或空格，再收一次。
    let clipped = clipped.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if clipped.is_empty() {
        return None;
    }
    Some(format!("{clipped}.png"))
}

fn is_forbidden_name_char(c: char) -> bool {
    // 路径分隔符已经在取末段时消掉了，这里只处理跨平台非法字符和控制符
    // （`\u{0}` 属于控制符，MediaStore 遇到它会直接抛 IllegalArgument）。
    c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')
}

fn sanitize_share_title(raw: Option<&str>) -> Option<String> {
    let candidate = raw?.trim();
    if candidate.is_empty() {
        return None;
    }
    let cleaned: String = candidate
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TITLE_CHARS)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

/// 给跨 JNI 的错误补上"我们在做什么"。Kotlin 的 `invoke.reject(ex.message)`
/// 经常只给一句 `null` 或空串，直接透传等于什么都没说。
fn describe_plugin_error(action: &str, err: impl std::fmt::Display) -> String {
    let detail = err.to_string();
    let detail = detail.trim();
    if detail.is_empty() || detail == "null" {
        format!("{action}（系统未返回具体原因）")
    } else {
        format!("{action}：{detail}")
    }
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

// 不要给这个类型手写 `unsafe impl Send/Sync`：`PluginHandle<R>` 本身就是
// `Send + Sync`（`app.manage` 的约束即为证明，见 apk_updater.rs 的同款
// 结构），让编译器自动推导才能在内部类型变化时暴露问题，而不是把
// 潜在的线程不安全静默掩盖成未定义行为。
#[derive(Clone)]
pub struct AndroidImageSharer<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> AndroidImageSharer<R> {
    fn init<C: serde::de::DeserializeOwned>(
        _app: &tauri::AppHandle<R>,
        api: PluginApi<R, C>,
    ) -> tauri::Result<Self> {
        let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, PLUGIN_CLASS)?;
        Ok(Self(handle))
    }

    /// `base64` 必须已经过 [`normalize_base64_payload`]，`file_name`
    /// 必须已经过 [`sanitize_png_file_name`]。
    ///
    /// 三条命令都走 `run_mobile_plugin_async`：同步版会在
    /// `std::sync::mpsc::recv()` 上挂起 tokio worker 直到 Kotlin resolve，
    /// 而几十 MB 的 base64 跨 JNI + 解码 + 落盘要数百毫秒到数秒，
    /// 与 apk_updater.rs 的下载同池——不该有任何一条命令占着线程干等。
    async fn save_image(
        &self,
        base64: String,
        file_name: Option<String>,
    ) -> PluginResult<SaveImageResponse> {
        let request = SaveImageRequest { base64, file_name };
        self.0
            .run_mobile_plugin_async("saveImage", request)
            .await
            .map_err(|err| describe_plugin_error("保存到相册失败", err))
    }

    async fn share_image(
        &self,
        base64: String,
        file_name: Option<String>,
        title: Option<String>,
    ) -> PluginResult<ShareImageResponse> {
        let request = ShareImageRequest {
            base64,
            file_name,
            title,
        };
        self.0
            .run_mobile_plugin_async("shareImage", request)
            .await
            .map_err(|err| describe_plugin_error("打开系统分享面板失败", err))
    }

    async fn open_storage_permission_settings(&self) -> PluginResult<()> {
        self.0
            .run_mobile_plugin_async::<()>("openStoragePermissionSettings", ())
            .await
            .map_err(|err| describe_plugin_error("打开系统设置失败", err))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一张 1×1 PNG 的合法 base64。
    fn valid_body() -> String {
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
            .to_string()
    }

    #[test]
    fn normalize_strips_data_url_prefix() {
        let body = valid_body();
        let input = format!("data:image/png;base64,{body}");
        assert_eq!(normalize_base64_payload(&input).unwrap(), body);
    }

    #[test]
    fn normalize_accepts_bare_base64_and_drops_whitespace() {
        let body = valid_body();
        let wrapped = format!("  {}\n{}  ", &body[..16], &body[16..]);
        assert_eq!(normalize_base64_payload(&wrapped).unwrap(), body);
    }

    #[test]
    fn normalize_rejects_empty_and_truncated_payloads() {
        assert!(normalize_base64_payload("   ").is_err());
        assert!(normalize_base64_payload("iVBORw0KGgo=").is_err());
        // 长度够但不是 4 的倍数 —— 典型的传输截断。
        let truncated = format!("{}x", valid_body());
        assert!(normalize_base64_payload(&truncated).is_err());
    }

    #[test]
    fn normalize_rejects_non_base64_data_urls() {
        let input = format!("data:image/svg+xml,{}", valid_body());
        let err = normalize_base64_payload(&input).unwrap_err();
        assert!(err.contains("base64"), "unexpected message: {err}");
    }

    #[test]
    fn normalize_requires_png_mime_and_signature() {
        let body = valid_body();
        assert_eq!(
            normalize_base64_payload(&format!("DATA:IMAGE/PNG;BASE64,{body}")).unwrap(),
            body
        );
        assert!(normalize_base64_payload(&format!("data:image/jpeg;base64,{body}")).is_err());

        // 长度与字符集都合法，但内容不是 PNG。
        let arbitrary = "A".repeat(88);
        assert!(normalize_base64_payload(&arbitrary).is_err());
    }

    #[test]
    fn normalize_rejects_padding_away_from_the_end() {
        let mut body = valid_body();
        body.replace_range(20..21, "=");
        assert_eq!(body.len() % 4, 0);
        assert!(normalize_base64_payload(&body).is_err());

        assert!(!has_valid_base64_shape("AAAA=AAA"));
        assert!(!has_valid_base64_shape("AAAA===="));
        assert!(has_valid_base64_shape("AAAA"));
        assert!(has_valid_base64_shape("AAA="));
    }

    #[test]
    fn normalize_rejects_illegal_characters() {
        let body = format!("{}中文中文", &valid_body()[..88]);
        assert!(normalize_base64_payload(&body).is_err());
    }

    #[test]
    fn sanitize_file_name_keeps_single_png_suffix() {
        assert_eq!(
            sanitize_png_file_name(Some("罗德岛.png")).as_deref(),
            Some("罗德岛.png")
        );
        assert_eq!(
            sanitize_png_file_name(Some("罗德岛.PNG")).as_deref(),
            Some("罗德岛.png")
        );
        assert_eq!(
            sanitize_png_file_name(Some("罗德岛")).as_deref(),
            Some("罗德岛.png")
        );
    }

    #[test]
    fn sanitize_file_name_strips_path_traversal() {
        assert_eq!(
            sanitize_png_file_name(Some("../../../etc/passwd")).as_deref(),
            Some("passwd.png")
        );
        assert_eq!(
            sanitize_png_file_name(Some(r"..\..\windows\evil.png")).as_deref(),
            Some("evil.png")
        );
        // 全是分隔符和点，剩不下任何有效主干。
        assert_eq!(sanitize_png_file_name(Some("../")), None);
    }

    #[test]
    fn sanitize_file_name_replaces_illegal_characters() {
        assert_eq!(
            sanitize_png_file_name(Some("0-1: 黑暗时代?<上>")).as_deref(),
            Some("0-1_ 黑暗时代__上_.png")
        );
        assert_eq!(
            sanitize_png_file_name(Some("tab\tname\u{0}")).as_deref(),
            Some("tab_name_.png")
        );
    }

    #[test]
    fn sanitize_file_name_truncates_without_splitting_chars() {
        let long = "章".repeat(200);
        let out = sanitize_png_file_name(Some(&long)).unwrap();
        assert!(out.ends_with(".png"));
        assert_eq!(out.chars().count(), MAX_FILE_NAME_CHARS + 4);
    }

    #[test]
    fn sanitize_file_name_handles_blank_and_missing_input() {
        assert_eq!(sanitize_png_file_name(None), None);
        assert_eq!(sanitize_png_file_name(Some("   ")), None);
        assert_eq!(sanitize_png_file_name(Some("...")), None);
        // 只有后缀，没有主干。
        assert_eq!(sanitize_png_file_name(Some(".png")), None);
    }

    /// 末尾是三字节汉字时 `len - 4` 落在字符中间，早期版本会在这里 panic。
    #[test]
    fn sanitize_file_name_does_not_panic_on_multibyte_tail() {
        assert_eq!(
            sanitize_png_file_name(Some("a章")).as_deref(),
            Some("a章.png")
        );
        assert_eq!(
            sanitize_png_file_name(Some("章")).as_deref(),
            Some("章.png")
        );
    }

    #[test]
    fn sanitize_title_trims_and_clips() {
        assert_eq!(sanitize_share_title(None), None);
        assert_eq!(sanitize_share_title(Some("  ")), None);
        assert_eq!(
            sanitize_share_title(Some("  黑暗时代\u{0}·上  ")).as_deref(),
            Some("黑暗时代·上")
        );
        let long = "标".repeat(500);
        assert_eq!(
            sanitize_share_title(Some(&long)).unwrap().chars().count(),
            MAX_TITLE_CHARS
        );
    }

    #[test]
    fn plugin_error_always_names_the_action() {
        assert_eq!(
            describe_plugin_error("保存到相册失败", "权限不足"),
            "保存到相册失败：权限不足"
        );
        assert_eq!(
            describe_plugin_error("保存到相册失败", "   "),
            "保存到相册失败（系统未返回具体原因）"
        );
        assert_eq!(
            describe_plugin_error("保存到相册失败", "null"),
            "保存到相册失败（系统未返回具体原因）"
        );
    }
}
