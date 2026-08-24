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
//!
//! **这个文件是 `src/lib/assetUrls.ts` 的镜像。** 前端为了省掉每张图一次
//! IPC，把同一套规则用 JS 重写了一遍；两边任何一处改动都必须同步，否则
//! 「Rust 说的候选」和「浏览器实际请求的候选」会各走各的。本文件末尾的
//! 单测钉住了几个容易漂移的点：内置 `/bundled/` 前缀、精二立绘顺序、
//! 活动 KV 的「原 token 优先」。
//!
//! 例外：assetUrls.ts 仍会拼出两处与镜像仓库真实布局不符的历史死模板
//! （fexli `charpor/{cid}.png`、Puppiiz `storyline/images|backgrounds/`），
//! 前端在 `src/hooks/useAsset.ts` 的解析出口统一修正成本文件的形态——
//! 对齐的是「浏览器最终请求的候选」，那边的修正规则变了这里也要跟。

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

/// 已知 NPC 头像覆盖表。这些角色不在 character_table 里（非干员），但在
/// 剧情中频繁出现。图片随前端一起打包在 `public/avatars/npc/`。
/// key = 中文名，与剧情脚本 `[name="..."]` 及 assetUrls.ts 保持一致。
const NPC_AVATAR_OVERRIDES: &[(&str, &str)] = &[
    ("普瑞赛斯", "/avatars/npc/priestess.png"),
    ("希尔达", "/avatars/npc/hierda.png"),
];

fn npc_override(token: &str) -> Option<&'static str> {
    NPC_AVATAR_OVERRIDES
        .iter()
        .find(|(name, _)| *name == token)
        .map(|(_, url)| *url)
}

fn resolve_char_id(token: &str) -> Option<String> {
    if token.starts_with("char_") {
        // Strip skin suffix `#N`
        let without_skin = token.split('#').next().unwrap_or(token);
        return Some(without_skin.to_string());
    }
    character_table::name_to_id(token)
}

fn avatar_candidates(token: &str) -> Vec<String> {
    if let Some(url) = npc_override(token) {
        return vec![url.to_string()];
    }
    let mut out = Vec::new();
    if let Some(cid) = resolve_char_id(token) {
        // 打包进 public/bundled/avatar/ 的内置头像，零网络开销，优先命中。
        out.push(format!("/bundled/avatar/{}.png", cid));
        // yuanyan3060 的 avatar 是 char_xxx.png
        out.push(format!("{}/avatar/{}.png", YUANYAN, cid));
        // fexli 的 charpor（半身像）可用作备胎，但该目录所有文件都带
        // 精英化后缀：绝大多数干员有 `{cid}_1.png`，个别没有精一素材的
        // （近卫阿米娅等）只有 `{cid}_2.png`；裸 `{cid}.png` 全库不存在。
        out.push(format!("{}/charpor/{}_1.png", FEXLI, cid));
        out.push(format!("{}/charpor/{}_2.png", FEXLI, cid));
        // PuppiizSunniiz avatars
        out.push(format!("{}/avatars/{}.png", PUPPIIZ, cid));
    }
    out
}

fn portrait_candidates(token: &str) -> Vec<String> {
    // NPC 没有 char_ ID，也就没有精二/精一立绘，只能复用覆盖表里那张图。
    if let Some(url) = npc_override(token) {
        return vec![url.to_string()];
    }
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

/// 去掉剧情脚本里插画 token 的 `$` 前缀。
///
/// 只削一层：assetUrls.ts 用的是 `/^\$/` 单次替换，`trim_start_matches`
/// 会把 `$$bg_xxx` 一路削光，两边就会去请求不同的 URL。
fn strip_dollar(token: &str) -> &str {
    token.strip_prefix('$').unwrap_or(token)
}

fn avg_candidates(token: &str) -> Vec<String> {
    let t = strip_dollar(token);
    // Puppiiz 仓库没有 `storyline/images/` 目录（storyline/ 下只有一批
    // abbr 图标），历史上的第三候选是全库 404，只会白吃一次请求并给
    // 该 host 的熔断计数记账，已删除。
    vec![
        format!("{}/avgs/{}.png", FEXLI, t),
        format!("{}/avgs/bg/{}.png", FEXLI, t),
    ]
}

fn background_candidates(token: &str) -> Vec<String> {
    let t = strip_dollar(token);
    // fexli 仓库里大多数背景在 `avgs/bg/<token>.png` 子目录，少部分老的在
    // `avgs/<token>.png` 根目录。按命中率排序。Puppiiz 没有
    // `storyline/backgrounds/` 目录，历史上的第三候选与 avg 同理已删除。
    vec![
        format!("{}/avgs/bg/{}.png", FEXLI, t),
        format!("{}/avgs/{}.png", FEXLI, t),
    ]
}

/// 去掉图片扩展名。与 assetUrls.ts 的 `/\.(png|jpg|jpeg|webp)$/i` 对齐：
/// 只削最后一层、大小写不敏感，不像 `trim_end_matches` 那样反复削。
///
/// 长度用 `>=` 判断：token 正好等于 `.png` 时 JS 正则同样会削成空串，
/// 用 `>` 会留下 `.png` 再拼一次后缀，两边的候选就对不上了。
fn strip_image_ext(token: &str) -> &str {
    for ext in [".png", ".jpg", ".jpeg", ".webp"] {
        if token.len() >= ext.len() {
            let split = token.len() - ext.len();
            // 切点落在多字节字符中间（token 以中文等结尾）时 `split_at`
            // 会 panic。这种位置是 UTF-8 续字节，不可能等于 ASCII 的 `.`，
            // 后缀必然不匹配——跳过即可，与 JS 正则「不匹配」的行为一致。
            if !token.is_char_boundary(split) {
                continue;
            }
            let (head, tail) = token.split_at(split);
            if tail.eq_ignore_ascii_case(ext) {
                return head;
            }
        }
    }
    token
}

/// 从活动 id 里猜 KV 素材名的核心部分：`act17side` → `side` 之类。
/// 猜错（削成空串，或压根没削掉东西）时返回 None，调用方只用原始 token。
///
/// 每个后缀只削一次——`trim_end_matches` 会把 `sideside` 一路削光，
/// assetUrls.ts 那边用的是单次 `slice`，这里必须一致。
fn strip_act_prefix(token: &str) -> Option<String> {
    let core = token
        .strip_prefix("act_")
        .or_else(|| token.strip_prefix("act"))
        .unwrap_or(token);
    let core = core.trim_start_matches(|c: char| c.is_ascii_digit());
    let core = core.strip_suffix("side").unwrap_or(core);
    let core = core.strip_suffix("mini").unwrap_or(core);
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
    let base = strip_image_ext(token);
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
    let base = strip_image_ext(token);
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
    let raw = token.strip_prefix("main_").unwrap_or(token).trim();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_assets_come_first() {
        // 内置素材零网络开销，必须排在任何远端源前面；前缀也得跟前端
        // `public/` 下的实际布局一致。
        let avatars = avatar_candidates("char_002_amiya");
        assert_eq!(avatars[0], "/bundled/avatar/char_002_amiya.png");

        let covers = chapter_cover_candidates("main_8");
        assert_eq!(covers[0], "/bundled/mapreview/main_08-01.png");
        assert!(covers[1].ends_with("/mapreview/main_08-01.png"));
    }

    #[test]
    fn portrait_prefers_elite_two() {
        let out = portrait_candidates("char_002_amiya");
        let first_e2 = out.iter().position(|u| u.contains("_2.png")).unwrap();
        let first_e1 = out.iter().position(|u| u.contains("_1.png")).unwrap();
        assert!(first_e2 < first_e1, "精二立绘必须排在精一之前: {out:?}");
    }

    #[test]
    fn fexli_avatar_backup_carries_elite_suffixes() {
        // fexli charpor 目录下没有裸 `{cid}.png`（全库皆为 `_1` / `_2` 等
        // 精英化后缀）。裸模板进候选链只会白吃一次 404，并给 fexli host 的
        // 熔断计数记一笔账——一屏头像攒够阈值就把整个 host 熔断，连坐
        // 插画/封面/KV。
        let out = avatar_candidates("char_002_amiya");
        let e1 = format!("{FEXLI}/charpor/char_002_amiya_1.png");
        let e2 = format!("{FEXLI}/charpor/char_002_amiya_2.png");
        let bare = format!("{FEXLI}/charpor/char_002_amiya.png");
        assert!(out.contains(&e1), "缺精一半身像备胎: {out:?}");
        assert!(out.contains(&e2), "缺精二半身像备胎（近卫阿米娅等无精一素材）: {out:?}");
        assert!(!out.contains(&bare), "裸 charpor 模板是全库 404，不得回归: {out:?}");
        // `_1` 几乎全员都有，排在 `_2` 前面少吃一次 404。
        let p1 = out.iter().position(|u| u == &e1).unwrap();
        let p2 = out.iter().position(|u| u == &e2).unwrap();
        assert!(p1 < p2);
    }

    #[test]
    fn story_art_chains_skip_missing_puppiiz_directories() {
        // Puppiiz 仓库没有 storyline/images 与 storyline/backgrounds 目录，
        // 这两条历史候选是全库 404，不得回归。
        for out in [avg_candidates("32_i06"), background_candidates("bg_courtyard")] {
            assert!(
                out.iter().all(|u| !u.contains("/storyline/")),
                "storyline 死模板不得回归: {out:?}"
            );
            assert!(!out.is_empty());
        }
    }

    #[test]
    fn npc_overrides_bypass_char_table() {
        assert_eq!(avatar_candidates("普瑞赛斯"), vec!["/avatars/npc/priestess.png"]);
        assert_eq!(portrait_candidates("希尔达"), vec!["/avatars/npc/hierda.png"]);
    }

    #[test]
    fn activity_kv_keeps_raw_token_first() {
        // `storyEntryPicId` 这类 token 已经是成品图片名，剥 `act` 前缀只会
        // 把它削坏，所以原始 token 永远排第一。
        let out = activity_kv_candidates("act17side_entrypic");
        assert_eq!(out[0], format!("{FEXLI}/kvimg/act17side_entrypic.png"));

        // 扩展名只削一层、大小写不敏感。
        let out = activity_kv_candidates("act17side_entrypic.PNG");
        assert_eq!(out[0], format!("{FEXLI}/kvimg/act17side_entrypic.png"));
    }

    #[test]
    fn dollar_prefix_is_stripped_exactly_once() {
        // 剧情脚本里的 `$bg_xxx`：削掉一个 `$` 就是真正的素材名。
        let out = avg_candidates("$avg_npc_001");
        assert_eq!(out[0], format!("{FEXLI}/avgs/avg_npc_001.png"));

        // 多个 `$` 时只削一层——assetUrls.ts 的 `/^\$/` 也只削一层，
        // 削多了两边就会请求不同的 URL。
        let out = background_candidates("$$bg_rhodes");
        assert_eq!(out[0], format!("{FEXLI}/avgs/bg/$bg_rhodes.png"));
    }

    #[test]
    fn strip_image_ext_matches_the_js_regex() {
        assert_eq!(strip_image_ext("act17side_entrypic.png"), "act17side_entrypic");
        assert_eq!(strip_image_ext("cover.JPEG"), "cover");
        // 只削最后一层。
        assert_eq!(strip_image_ext("cover.png.webp"), "cover.png");
        // 不是图片后缀的不动。
        assert_eq!(strip_image_ext("kv_main.v2"), "kv_main.v2");
        // token 本身就是个裸后缀：JS 正则会削成空串，这里必须一致。
        assert_eq!(strip_image_ext(".png"), "");
    }

    #[test]
    fn strip_image_ext_survives_multibyte_tails() {
        // token 以多字节字符结尾时，`len - ext.len()` 可能落在 UTF-8 字符
        // 中间（如 `act_封面`：10 字节，削 `.png` 的切点 6 在「封」内部），
        // `split_at` 会 panic 把整条 resolve 命令带崩；JS 正则对这种 token
        // 只是不匹配。两边都必须原样返回。
        assert_eq!(strip_image_ext("act_封面"), "act_封面");
        assert_eq!(strip_image_ext("活动"), "活动");
        // 多字节主体 + 合法 ASCII 后缀仍然照削。
        assert_eq!(strip_image_ext("封面.png"), "封面");
    }

    #[test]
    fn strip_act_prefix_declines_when_it_would_empty_the_token() {
        // 削空 → 只能用原 token。
        assert_eq!(strip_act_prefix("act17side"), None);
        assert_eq!(strip_act_prefix("act"), None);
        // 什么都没削掉 → 也不值得再多发一轮请求。
        assert_eq!(strip_act_prefix("entrypic"), None);
        // 每个后缀只削一次，不能像 trim_end_matches 那样一路削光。
        assert_eq!(strip_act_prefix("act1sideside").as_deref(), Some("side"));
    }
}
