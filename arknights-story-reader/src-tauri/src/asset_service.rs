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
        // yuanyan3060 portrait 命名为 char_xxx_1.png（默认 e0 立绘）
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
        format!("{}/storyline/images/{}.png", PUPPIIZ, t),
    ]
}

fn background_candidates(token: &str) -> Vec<String> {
    let t = token.trim_start_matches('$');
    vec![
        format!("{}/avgs/{}.png", FEXLI, t),
        format!("{}/storyline/backgrounds/{}.png", PUPPIIZ, t),
    ]
}

fn activity_kv_candidates(token: &str) -> Vec<String> {
    // 活动 id 形如 `act17side`、`act20side`，相关 KV 命名多种；
    // 剥掉 `act` 前缀后大多数情况下对应 fexli/kvimg 的 token。
    let core = token
        .strip_prefix("act_")
        .or_else(|| token.strip_prefix("act"))
        .unwrap_or(token);
    let core = core.trim_start_matches(|c: char| c.is_ascii_digit());
    let core = core.trim_end_matches("side");
    let core = core.trim_end_matches("mini");
    vec![
        format!("{}/kvimg/default_kv_{}.png", FEXLI, core),
        format!("{}/kvimg/kv_{}1.png", FEXLI, core),
        format!("{}/kvimg/kv_{}.png", FEXLI, core),
    ]
}

fn activity_logo_candidates(token: &str) -> Vec<String> {
    let core = token
        .strip_prefix("act_")
        .or_else(|| token.strip_prefix("act"))
        .unwrap_or(token);
    let core = core.trim_start_matches(|c: char| c.is_ascii_digit());
    let core = core.trim_end_matches("side");
    let core = core.trim_end_matches("mini");
    vec![
        format!("{}/kvimg/brand_{}.png", FEXLI, core),
        format!("{}/camplogo/logo_{}.png", FEXLI, core),
    ]
}

fn chapter_cover_candidates(token: &str) -> Vec<String> {
    // 主线章节 token 多为 `main_08`，对应背景 `bg_main_08` 或剧情插画 `avg_8_xx`
    let t = token.trim_start_matches("main_");
    vec![
        format!("{}/avgs/bg_main_{}.png", FEXLI, t),
        format!("{}/avgs/{}_i01.png", FEXLI, t),
        format!("{}/avgs/{}_I01.png", FEXLI, t),
    ]
}
