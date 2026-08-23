//! 素材 URL 解析服务。
//!
//! 为了保持轻量（不在 Rust 侧跑异步 HTTP 与图像缓存），这里只负责把
//! 「素材种类 + token」转成一组候选 URL。前端 `<AssetImage>` 按顺序尝试，
//! 第一个能加载的就用；Tauri 的 WebView 自己会处理磁盘缓存。
//!
//! 四级数据源（与 PART G 一致）：
//!   1. yuanyan3060/ArknightsGameResource  —— 干员头像/半身像
//!   2. fexli/ArknightsResource            —— 剧情插画、活动 KV、阵营 LOGO
//!   3. PuppiizSunniiz/Arknight-Images     —— 头像/立绘备选
//!   4. PRTS.wiki 直链（已知命名）         —— 某些活动图标
//!
//! 不走 PRTS MediaWiki API（异步往返成本过高），直接使用约定式 URL。
//! 若将来需要 API 解析，可在此扩展 `resolve_prts(kind, token)`。

use serde::{Deserialize, Serialize};

use crate::character_table;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    /// 干员头像 48x48，token=`char_xxx` 或中文名
    Avatar,
    /// 干员半身像，token=`char_xxx_N` 或中文名
    Portrait,
    /// 剧情插画，token=`avg_xxx` / `g_xx_Ixx`
    Image,
    /// 章节/场景背景，token=`bg_xxx`
    Background,
    /// 活动封面 KV，token=`act_xxx` / `{token}`
    ActivityKv,
    /// 活动 LOGO / Brand，token=`{actId 后缀}` 或 `act_xxx`
    ActivityLogo,
    /// 章节封面，token=`main_xx`
    ChapterCover,
}

/// 解析一条候选 URL 列表，前端按顺序 fallback。
pub fn resolve(kind: AssetKind, token: &str) -> Vec<String> {
    let token = token.trim();
    if token.is_empty() {
        return Vec::new();
    }
    match kind {
        AssetKind::Avatar => avatar_candidates(token),
        AssetKind::Portrait => portrait_candidates(token),
        AssetKind::Image => avg_candidates(token),
        AssetKind::Background => background_candidates(token),
        AssetKind::ActivityKv => activity_kv_candidates(token),
        AssetKind::ActivityLogo => activity_logo_candidates(token),
        AssetKind::ChapterCover => chapter_cover_candidates(token),
    }
}

const YUANYAN: &str = "https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main";
const FEXLI: &str = "https://raw.githubusercontent.com/fexli/ArknightsResource/main";
const PUPPIIZ: &str = "https://raw.githubusercontent.com/PuppiizSunniiz/Arknight-Images/main";

fn resolve_char_id(token: &str) -> Option<String> {
    if token.starts_with("char_") {
        // Strip skin suffix `#N`
        let without_skin = token.split('#').next().unwrap_or(token);
        return Some(without_skin.to_string());
    }
    character_table::name_to_id(token)
}

fn avatar_candidates(token: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(cid) = resolve_char_id(token) {
        // 打包进 public/bundled/avatar/ 的内置头像，零网络开销，优先命中。
        out.push(format!("/bundled/avatar/{}.png", cid));
        // yuanyan3060 的 avatar 是 char_xxx.png
        out.push(format!("{}/avatar/{}.png", YUANYAN, cid));
        // fexli 也有 charpor（半身），同路径也可用作备胎
        out.push(format!("{}/charpor/{}.png", FEXLI, cid));
        // PuppiizSunniiz avatars
        out.push(format!("{}/avatars/{}.png", PUPPIIZ, cid));
    }
    out
}

fn portrait_candidates(token: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(cid) = resolve_char_id(token) {
        // 精二立绘（`_2`）优先，缺素材时才回落到精一（`_1`）。
        out.push(format!("{}/portrait/{}_2.png", YUANYAN, cid));
        out.push(format!("{}/charpack/{}_2.png", FEXLI, cid));
        out.push(format!("{}/characters/{}_2.png", PUPPIIZ, cid));
        out.push(format!("{}/portrait/{}_1.png", YUANYAN, cid));
        out.push(format!("{}/portrait/{}_1b.png", YUANYAN, cid));
        out.push(format!("{}/charpack/{}_1.png", FEXLI, cid));
        out.push(format!("{}/characters/{}_1.png", PUPPIIZ, cid));
    }
    out
}

fn avg_candidates(token: &str) -> Vec<String> {
    let t = token.trim_start_matches('$');
    vec![
        format!("{}/avgs/{}.png", FEXLI, t),
        format!("{}/avgs/bg/{}.png", FEXLI, t),
        format!("{}/storyline/images/{}.png", PUPPIIZ, t),
    ]
}

fn background_candidates(token: &str) -> Vec<String> {
    let t = token.trim_start_matches('$');
    // fexli 仓库里大多数背景在 `avgs/bg/<token>.png` 子目录，少部分老的在
    // `avgs/<token>.png` 根目录。按命中率排序。
    vec![
        format!("{}/avgs/bg/{}.png", FEXLI, t),
        format!("{}/avgs/{}.png", FEXLI, t),
        format!("{}/storyline/backgrounds/{}.png", PUPPIIZ, t),
    ]
}

/// 从活动 id 里猜 KV 素材名的核心部分：`act17side` → `side` 之类。
/// 猜错（削成空串）时返回 None，调用方只用原始 token。
fn strip_act_prefix(token: &str) -> Option<String> {
    let core = token
        .strip_prefix("act_")
        .or_else(|| token.strip_prefix("act"))
        .unwrap_or(token);
    let core = core.trim_start_matches(|c: char| c.is_ascii_digit());
    let core = core.trim_end_matches("side");
    let core = core.trim_end_matches("mini");
    if core.is_empty() || core == token {
        None
    } else {
        Some(core.to_string())
    }
}

fn activity_kv_candidates(token: &str) -> Vec<String> {
    // token 可能已经是 story_review_table 给的图片名（`storyPic` /
    // `storyEntryPicId`，形如 `act17side_entrypic`），这种情况下再去剥
    // `act` 前缀只会把它削坏，所以原始 token 永远排在候选表最前面。
    let base = token.trim_end_matches(".png").trim_end_matches(".jpg");
    let mut out = vec![
        format!("{}/kvimg/{}.png", FEXLI, base),
        format!("{}/kvimg/default_kv_{}.png", FEXLI, base),
        format!("{}/kvimg/kv_{}.png", FEXLI, base),
    ];
    // 旧的启发式猜测保留作兜底。
    if let Some(core) = strip_act_prefix(base) {
        out.push(format!("{}/kvimg/default_kv_{}.png", FEXLI, core));
        out.push(format!("{}/kvimg/kv_{}1.png", FEXLI, core));
        out.push(format!("{}/kvimg/kv_{}.png", FEXLI, core));
    }
    dedup(out)
}

fn activity_logo_candidates(token: &str) -> Vec<String> {
    let base = token.trim_end_matches(".png").trim_end_matches(".jpg");
    let mut out = vec![
        format!("{}/kvimg/brand_{}.png", FEXLI, base),
        format!("{}/camplogo/logo_{}.png", FEXLI, base),
    ];
    if let Some(core) = strip_act_prefix(base) {
        out.push(format!("{}/kvimg/brand_{}.png", FEXLI, core));
        out.push(format!("{}/camplogo/logo_{}.png", FEXLI, core));
    }
    dedup(out)
}

fn chapter_cover_candidates(token: &str) -> Vec<String> {
    // 主线章节 token 多为 `main_8`，对应封面 `main_08-01`、背景 `bg_main_8`
    // 或剧情插画 `8_i01`。
    let raw = token.trim_start_matches("main_").trim();
    let padded = if raw.chars().all(|c| c.is_ascii_digit()) && !raw.is_empty() {
        format!("{:0>2}", raw)
    } else {
        raw.to_string()
    };
    dedup(vec![
        // 打包进 public/bundled/mapreview/ 的内置章节封面。
        format!("/bundled/mapreview/main_{}-01.png", padded),
        format!("{}/mapreview/main_{}-01.png", FEXLI, padded),
        format!("{}/avgs/bg_main_{}.png", FEXLI, raw),
        format!("{}/avgs/{}_i01.png", FEXLI, raw),
        format!("{}/avgs/{}_I01.png", FEXLI, raw),
    ])
}

fn dedup(urls: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    urls.into_iter().filter(|u| seen.insert(u.clone())).collect()
}
