use crate::models::{ParsedStoryContent, StorySegment};
use lazy_static::lazy_static;
use regex::Regex;
use std::collections::HashMap;

lazy_static! {
    /// `key="value"`、`key='value'` 以及无引号的 `key=value`。数值型属性
    /// （`focus=2`、`fadetime=0.7`）从来不加引号；act15mini 还有一批
    /// `[name='麦哲伦']` 的单引号写法，不认单引号就会把引号一起当成名字。
    static ref ATTR_RE: Regex = Regex::new(r#"(?i)([a-z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,()\[\]"]+))"#)
        .expect("invalid attribute regex");
    static ref GENERIC_TAG_RE: Regex = Regex::new(r#"<[^>]+>"#).expect("invalid generic tag regex");
    static ref PARAGRAPH_TAG_RE: Regex =
        Regex::new(r"(?i)<p[^>]*>").expect("invalid paragraph tag regex");
    static ref LINE_BREAK_TAG_RE: Regex =
        Regex::new(r"(?i)<br\s*/?>").expect("invalid line break tag regex");
    static ref NICKNAME_RE: Regex =
        Regex::new(r"(?i)\{@nickname\}").expect("invalid nickname regex");
}

/// 立绘变体后缀：`#4`（表情）、`$1`（差分）、`_1`/`_2`（皮肤）、`_ex`（异格）。
/// 这些都不影响「是谁」，剥掉之后才能对上头像仓库里的文件名。
fn strip_art_variants(token: &str, keep_at_least: usize) -> Vec<&str> {
    let base = token
        .split(|c| c == '#' || c == '$')
        .next()
        .unwrap_or(token);
    let mut parts: Vec<&str> = base.split('_').filter(|p| !p.is_empty()).collect();
    while parts.len() > keep_at_least {
        let is_variant = parts
            .last()
            .map(|last| last.eq_ignore_ascii_case("ex") || last.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false);
        if !is_variant {
            break;
        }
        parts.pop();
    }
    parts
}

/// Normalize a `char_XXX_name#N` / `char_XXX_name_1` token to `char_XXX_name`.
/// Strips `#` / `$` expression suffixes and trailing `_1` / `_2` / `_ex` art
/// variants so the frontend can map to the avatar repo (`char_345_folnic.png`).
fn normalize_char_id(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"').trim_start_matches('$');
    let base = trimmed
        .split(|c| c == '#' || c == '$')
        .next()
        .unwrap_or(trimmed);
    let parts: Vec<&str> = base.split('_').filter(|p| !p.is_empty()).collect();
    if parts.len() >= 3 && parts[0] == "char" {
        // `char_002_amiya` 的三段是身份本体，再往后才是立绘变体。
        return strip_art_variants(trimmed, 3).join("_");
    }
    base.to_string()
}

/// 教程/训练/沙盒脚本会用行尾 `\` 把一条指令折成好几行（training_8_b.txt：
/// `[PopupDialog(focusX=..., \` + `animStyle="Highlight", \` + `...)] \` + 正文）。
/// 逐物理行解析会把属性续行整行漏成旁白、把孤零零的 `\` 当正文，还把教程
/// 文字跟 dialogHead 说话人拆散——先拼回逻辑行再解析。
///
/// 语料里续行的第一行必然以 `[` 开头（正文行从不以 `\` 结尾），所以只认
/// 指令行，防止误吞真的以反斜杠收尾的台词。空行和新的指令行都终止续行：
/// 纯手势教程（`[Tutorial(...)] \`）后面可能直接空行，也可能不留空行就接
/// 下一条指令——把 `[` 开头的行拼进来会让那条指令的原文漏成教程正文、
/// 指令本身（可能是一句对白）也被吞掉。属性续行（`animStyle=..., \`）和
/// 教程正文从不以 ASCII `[` 开头，中文正文用的是全角【】。
fn logical_lines(content: &str) -> Vec<std::borrow::Cow<'_, str>> {
    use std::borrow::Cow;
    let mut out: Vec<Cow<'_, str>> = Vec::new();
    let mut buf: Option<String> = None;
    for raw in content.lines() {
        let end_trimmed = raw.trim_end();
        let stripped = end_trimmed.trim_start();
        if let Some(joined) = buf.as_mut() {
            if !stripped.is_empty() && !stripped.starts_with('[') {
                joined.push(' ');
                match end_trimmed.strip_suffix('\\') {
                    Some(more) => joined.push_str(more),
                    None => {
                        joined.push_str(end_trimmed);
                        out.push(Cow::Owned(std::mem::take(joined)));
                        buf = None;
                    }
                }
                continue;
            }
            // 续行终止；`[` 开头的当前行还要按普通行重新走一遍下面的逻辑
            // （它自己也可能又是一条续行的开头）。
            out.push(Cow::Owned(std::mem::take(joined)));
            buf = None;
            if stripped.is_empty() {
                continue;
            }
        }
        match end_trimmed.strip_suffix('\\') {
            Some(head) if head.trim_start().starts_with('[') => {
                buf = Some(head.to_string());
            }
            _ => out.push(Cow::Borrowed(raw)),
        }
    }
    if let Some(joined) = buf {
        out.push(Cow::Owned(joined));
    }
    out
}

pub fn parse_story_text(content: &str) -> ParsedStoryContent {
    let mut segments = Vec::new();
    // Tracks the most recent [Character(name="char_xxx")] declaration so
    // dialogue lines below it can carry the speaker's charId. ArknightsAVG
    // scripts always declare speaker *before* the dialogue line.
    let mut current_char_id: Option<String> = None;

    for raw_line in logical_lines(content) {
        let mut line = raw_line.trim();

        // Update the current speaker's charId without emitting a segment.
        // Newer scripts use `[charslot(name="char_xxx")]` instead of
        // `[Character]`. Empty or missing `name` clears the state.
        //
        // 循环而不是只看一次：`[Character(...)][name="A"]台词` 这种把状态指令
        // 和台词写在同一行的脚本并不少见，只吃掉前缀、剩下的照常解析，否则
        // 整句台词会跟着指令一起被丢掉。
        let mut ate_state_prefix = false;
        while line.starts_with('[') {
            let Some(cmd_end) = find_command_end(line) else {
                break;
            };
            let inside = &line[1..cmd_end];
            let (cmd, _) = split_command_and_attrs(inside);
            if !is_speaker_state_command(&cmd.to_ascii_lowercase()) {
                break;
            }
            current_char_id = speaker_char_id(&parse_attributes(inside));
            line = line[cmd_end + 1..].trim();
            ate_state_prefix = true;
        }

        if line.is_empty() {
            continue;
        }

        // 只有真正闭合的方括号才是指令。`[` 开头但没有 `]` 的行是正文
        // （台词里出现半个括号并不稀奇），当指令处理会整行消失。
        if line.starts_with('[') && line.contains(']') {
            if let Some(segment) = parse_command_line(line, current_char_id.as_deref()) {
                segments.push(segment);
            }
            continue;
        }

        let text = clean_text(line);
        // 状态指令后面偶尔粘着数据残次（`[character]]` 的多余 `]`、
        // `[charslot(...)]4` 的手滑字符、main_12-17 的编辑批注 `已改`）。
        // 真实脚本里状态指令后从来没有正经台词直接开口——全语料这种残渣
        // 共 31 处、全部 ≤2 个字符，其中 CJK 渣（`已改`、`我`）是合法
        // 文字，能穿过 has_meaningful_content，所以再加一道字符数门槛。
        // 独立成行的正文（歌声淡出的 `...`、单字 "咦"）没有状态前缀，
        // 不受影响。
        if ate_state_prefix && (text.chars().count() <= 2 || !has_meaningful_content(&text)) {
            continue;
        }
        if !text.is_empty() {
            segments.push(StorySegment::Narration { text });
        }
    }

    ParsedStoryContent { segments }
}

fn parse_command_line(line: &str, current_char_id: Option<&str>) -> Option<StorySegment> {
    let end = find_command_end(line)?;
    let inside = &line[1..end];
    let remainder = line[end + 1..].trim();

    let (command, attr_source) = split_command_and_attrs(inside);
    let command = command.to_ascii_lowercase();
    let attrs = parse_attributes(inside);

    match command.as_str() {
        "name" => {
            let character_name = attrs
                .get("name")
                .map(|s| normalize_speaker_name(s))
                .unwrap_or_default();
            let text = clean_text(remainder);
            if text.is_empty() {
                return None;
            }
            if character_name.is_empty() {
                // 空名字多数用于场景字幕/地点时间
                return Some(StorySegment::Subtitle {
                    text,
                    alignment: None,
                });
            }
            // `[name="xxx"]` 是对话显示名，权威来源。不要继承上一条
            // `[Character(name="char_...")]` 的 charId——脚本常常在同一
            // `[Character]` 还没翻页的情况下切换说话人（尤其罗德岛多人同场）。
            // 让前端通过 `character_table` 用 `character_name` 反查 charId。
            Some(StorySegment::Dialogue {
                character_name,
                text,
                position: None,
                character_id: None,
            })
        }
        "multiline" => {
            let text = clean_text(remainder);
            if text.is_empty() {
                return None;
            }
            let character_name = attrs
                .get("name")
                .map(|s| normalize_speaker_name(s))
                .unwrap_or_default();
            if character_name.is_empty() {
                // 续行有时省略 `name`；宁可少一个说话人，也不能把整段台词丢掉。
                return Some(StorySegment::Narration { text });
            }
            // 同 `name`：显示名权威，不继承 current_char_id。
            Some(StorySegment::Dialogue {
                character_name,
                text,
                position: None,
                character_id: None,
            })
        }
        "decision" => {
            // 前端按 `values[optionIndex]` 取每个选项的标签，两个 Vec 必须
            // 逐位对齐。空选项要连同它自己的 value 一起丢；某个下标缺 value
            // 时用空串占位（前端把空串当没有）——绝不能把后面的 value 平移
            // 到前面的选项头上。
            let mut options = Vec::new();
            let mut values = Vec::new();
            if let Some(raw_options) = attrs.get("options") {
                // 分号形态：`options="走;留", values="1;2"`，按分号下标配对。
                let raw_values: Option<Vec<String>> = attrs
                    .get("values")
                    .map(|v| v.split(';').map(|s| clean_text(s)).collect());
                for (idx, raw_option) in raw_options.split(';').enumerate() {
                    let option_text = clean_text(raw_option);
                    if option_text.is_empty() {
                        continue;
                    }
                    options.push(option_text);
                    if let Some(vals) = &raw_values {
                        values.push(vals.get(idx).cloned().unwrap_or_default());
                    }
                }
            } else {
                // 编号形态：`option1=.../value1=...`。脚本可能乱序或跳号
                // （option1/option3），按「第几个出现」数就会张冠李戴，
                // 必须按数字下标配对。
                let target_source = attr_source.unwrap_or(inside);
                let mut numbered_options: Vec<(u64, String)> = Vec::new();
                let mut numbered_values: HashMap<u64, String> = HashMap::new();
                for caps in ATTR_RE.captures_iter(target_source) {
                    let Some(key) = caps.get(1) else { continue };
                    let Some(value) =
                        caps.get(2).or_else(|| caps.get(3)).or_else(|| caps.get(4))
                    else {
                        continue;
                    };
                    let key = key.as_str().to_ascii_lowercase();
                    if let Some(idx) = key
                        .strip_prefix("option")
                        .and_then(|n| n.parse::<u64>().ok())
                    {
                        numbered_options.push((idx, clean_text(value.as_str())));
                    } else if let Some(idx) = key
                        .strip_prefix("value")
                        .and_then(|n| n.parse::<u64>().ok())
                    {
                        numbered_values.insert(idx, clean_text(value.as_str()));
                    }
                }
                // 稳定排序：同一下标写两遍时保持文档顺序。
                numbered_options.sort_by_key(|(idx, _)| *idx);
                let has_values = !numbered_values.is_empty();
                for (idx, option_text) in numbered_options {
                    if option_text.is_empty() {
                        continue;
                    }
                    options.push(option_text);
                    if has_values {
                        values.push(numbered_values.get(&idx).cloned().unwrap_or_default());
                    }
                }
            }

            if options.is_empty() {
                return None;
            }

            Some(StorySegment::Decision { options, values })
        }
        "popupdialog" | "tutorial" => {
            let text = clean_text(remainder);
            if text.is_empty() {
                return None;
            }
            let speaker = attrs
                .get("dialoghead")
                .map(|s| clean_dialog_head(s))
                .filter(|s| !s.is_empty());
            Some(StorySegment::System { speaker, text })
        }
        "image" => {
            // 原始形如：[Image(image="avg_8_34",screenadapt="coverall",fadetime=2)]
            let token = attrs
                .get("image")
                .map(|s| s.trim().trim_matches('"').to_string())
                .filter(|s| !s.is_empty())?;
            let caption = attrs
                .get("caption")
                .or_else(|| attrs.get("text"))
                .map(|s| clean_text(s))
                .filter(|s| !s.is_empty());
            Some(StorySegment::Image { token, caption })
        }
        "playmusic" => {
            let key = attrs
                .get("key")
                .or_else(|| attrs.get("intro"))
                .map(|s| s.trim().trim_matches('"').to_string())
                .filter(|s| !s.is_empty())?;
            Some(StorySegment::Music { key })
        }
        "subtitle" => {
            let text = overlay_text(&attrs, remainder)?;
            let alignment = attrs.get("alignment").map(|s| s.trim().to_string());
            Some(StorySegment::Subtitle { text, alignment })
        }
        "sticker" => {
            let text = overlay_text(&attrs, remainder)?;
            let alignment = attrs.get("alignment").map(|s| s.trim().to_string());
            Some(StorySegment::Sticker { text, alignment })
        }
        "header" => {
            let title = clean_text(remainder);
            if title.is_empty() {
                return None;
            }
            Some(StorySegment::Header { title })
        }
        "dialog" => parse_dialog_like(&attrs, remainder, current_char_id),
        "voicewithin" => parse_dialog_like(&attrs, remainder, current_char_id),
        "narration" => {
            let text = if remainder.is_empty() {
                attrs.get("text").map(|t| clean_text(t)).unwrap_or_default()
            } else {
                clean_text(remainder)
            };
            if !has_meaningful_content(&text) {
                return None;
            }
            Some(StorySegment::Narration { text })
        }
        "animtext" => {
            let text = clean_text(remainder)
                .if_empty_then(|| attrs.get("text").map(|t| clean_text(t)).unwrap_or_default());
            let text = text.trim().to_string();
            if !has_meaningful_content(&text) {
                return None;
            }
            Some(StorySegment::Sticker {
                text,
                alignment: None,
            })
        }
        "title" => {
            let title = clean_text(remainder);
            if !has_meaningful_content(&title) {
                return None;
            }
            Some(StorySegment::Header { title })
        }
        "div" => {
            let text = clean_text(remainder);
            if !has_meaningful_content(&text) {
                return None;
            }
            Some(StorySegment::Subtitle {
                text,
                alignment: None,
            })
        }
        "avatarid" | "isavatarright" => {
            let text = clean_text(remainder);
            if !has_meaningful_content(&text) {
                return None;
            }
            Some(StorySegment::System {
                speaker: resolve_speaker(&attrs),
                text,
            })
        }
        // 纯演出指令：整条丢掉。极少数脚本会把旁白直接接在演出指令后面，
        // 所以还是先看一眼 `]` 之后有没有正文，有就留成旁白。
        cmd if is_stage_direction(cmd) => {
            let text = clean_text(remainder);
            if has_meaningful_content(&text) {
                Some(StorySegment::Narration { text })
            } else {
                None
            }
        }
        // 其他命令若仍包含文本，则作为旁白处理。没写在 `]` 后面的话，
        // `text=` 属性是脚本放正文的另一个固定位置（`[Announce(text="...")]`
        // 之类），不看它就会把这行字整段丢掉。
        _ => {
            let text = clean_text(remainder)
                .if_empty_then(|| attrs.get("text").map(|t| clean_text(t)).unwrap_or_default());
            if !has_meaningful_content(&text) {
                None
            } else {
                Some(StorySegment::Narration { text })
            }
        }
    }
}

/// `[Subtitle]` / `[Sticker]` 的正文：标准写法在 `text=` 属性里，但老脚本
/// 偶尔把正文直接写在 `]` 后面（`[Subtitle] 正文`），只认属性会把整句丢掉。
/// 裸指令（清掉屏幕上字幕/贴纸的信号）和残渣级 remainder（`[Sticker]。`
/// 这类手滑标点）都不算正文——不能因此产出空段或渣段。
fn overlay_text(attrs: &HashMap<String, String>, remainder: &str) -> Option<String> {
    attrs
        .get("text")
        .map(|t| clean_text(t))
        .filter(|t| !t.is_empty())
        .or_else(|| {
            let trailing = clean_text(remainder);
            has_meaningful_content(&trailing).then_some(trailing)
        })
}

/// 只更新「当前说话人」而不产出任何段落的指令。
fn is_speaker_state_command(command: &str) -> bool {
    matches!(command, "character" | "charslot")
}

/// `[Character(name="A", name2="B", focus=2)]` 里 `focus` 指出正在说话的是
/// 哪一位立绘；不看它就会把第二位的台词记成第一位，头像整段跟着错。
fn speaker_char_id(attrs: &HashMap<String, String>) -> Option<String> {
    let focus_second = attrs.get("focus").map(|v| v.trim() == "2").unwrap_or(false);
    let (primary, secondary) = if focus_second {
        ("name2", "name")
    } else {
        ("name", "name2")
    };
    attrs
        .get(primary)
        .or_else(|| attrs.get(secondary))
        .or_else(|| attrs.get("a"))
        .or_else(|| attrs.get("b"))
        .map(|s| normalize_char_id(s))
        .filter(|s| s.starts_with("char_"))
}

/// 纯演出 / 流程控制指令：镜头、音效、立绘、转场、分支断言等等。它们在脚本里
/// 从不携带要显示的正文，落到兜底分支就会把 `avg_xxx`、`fx_snow` 这类素材名
/// 当旁白印到正文里。
///
/// 名单只收「确定不带正文」的指令；拿不准的一律留给兜底分支，宁可多一行噪音，
/// 也不能吃掉真台词。
fn is_stage_direction(command: &str) -> bool {
    matches!(
        command,
        // 场景与背景。Background 被有意忽略：它是 AVG 的场景切换信号，一章会
        // 出现几十条，当成 16:9 大图渲染会把正文切得稀碎；真正值得渲染的是
        // `[Image]`（在上面单独处理）。
        "background"
            | "backgroundtween"
            | "bgeffect"
            | "stopbgeffect"
            | "bgshake"
            | "imagetween"
            | "largebg"
            | "gridbg"
            | "verticalbg"
            | "fullscreencg"
            // 立绘
            | "character"
            | "charslot"
            | "charsloteasing"
            | "chartilt"
            | "charfade"
            | "charrelease"
            | "charstop"
            | "characteraction"
            | "charactercutin"
            | "smallcharacter"
            // 镜头
            | "camerashake"
            | "stopcamerashake"
            | "cameraeffect"
            | "stopcameraeffect"
            | "camerascale"
            | "cameraposition"
            | "camerapan"
            // 特效与遮罩
            | "effect"
            | "stopeffect"
            | "curtain"
            | "blocker"
            | "stopblocker"
            // 节奏
            | "delay"
            | "fadetime"
            | "setavgspeed"
            // 声音（PlayMusic 在上面产出 Music 段，不在此列）
            | "stopmusic"
            | "musicvolume"
            | "playsound"
            | "stopsound"
            | "soundvolume"
            | "playvoice"
            | "stopvoice"
            | "voice"
            // 视频与图鉴
            | "video"
            | "playvideo"
            | "stopvideo"
            | "gallery"
            // 道具
            | "showitem"
            | "hideitem"
            | "obtainitem"
            | "cgitem"
            // 流程控制
            | "predicate"
            | "trigger"
            | "timer"
            | "skipnode"
            | "skiptonode"
            | "gotopage"
            // 对话框与浮层的开关
            | "dialogtransition"
            | "hidedialog"
            | "showdialog"
            | "stickerclear"
            | "subtitleclear"
            | "stopsubtitle"
    )
}

/// 指令真正的闭合 `]`：引号里的 `]` 是属性值的一部分，不是指令结束。
/// `[Sticker(text="…[DWDB-221E]建立…")]`（story_cetsyr_1_1）在引号中途截断
/// 会让 `text` 属性解析不出来，整条贴纸文字消失。真实脚本里引号总是成对；
/// 万一不成对，退回第一个 `]`，行为不比从前差。
fn find_command_end(line: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    for (idx, ch) in line.char_indices() {
        match quote {
            Some(q) => {
                if ch == q {
                    quote = None;
                }
            }
            None => match ch {
                '"' | '\'' => quote = Some(ch),
                ']' => return Some(idx),
                _ => {}
            },
        }
    }
    line.find(']')
}

fn split_command_and_attrs(inside: &str) -> (String, Option<&str>) {
    let inside = inside.trim();
    if inside.is_empty() {
        return (String::new(), None);
    }

    let mut end_idx = inside.len();
    for (idx, ch) in inside.char_indices() {
        if ch == '(' || ch == ' ' || ch == '=' {
            end_idx = idx;
            break;
        }
    }

    let command = inside[..end_idx].to_string();
    let attrs = if end_idx < inside.len() {
        Some(inside[end_idx..].trim())
    } else {
        None
    };

    (command, attrs)
}

fn parse_attributes(source: &str) -> HashMap<String, String> {
    let mut attrs = HashMap::new();
    for caps in ATTR_RE.captures_iter(source) {
        let Some(key) = caps.get(1) else { continue };
        // 组 2/3 = 双/单引号（可能是空串），组 4 = 不带引号。
        let Some(value) = caps.get(2).or_else(|| caps.get(3)).or_else(|| caps.get(4)) else {
            continue;
        };
        attrs.insert(
            key.as_str().to_ascii_lowercase(),
            value.as_str().to_string(),
        );
    }
    attrs
}

fn clean_dialog_head(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    humanize_identifier(trimmed)
}

/// 说话人是一行标签，不是正文：所有产出 `character_name` / `speaker` 的分支
/// 都必须走这里，否则 `{@nickname}`、`<color=...>` 之类会原样印在名字上，
/// 同一个角色还会因为写法不同在搜索里散成好几个人。
fn normalize_speaker_name(raw: &str) -> String {
    let cleaned = clean_text(raw.trim().trim_matches('"'));
    if cleaned.is_empty() {
        return String::new();
    }
    // 名字里的换行/连续空格一律折成一个半角空格（"Rhodes  Island" → "Rhodes Island"）。
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_text(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut cleaned = text
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace('\r', "\n")
        .replace('\u{3000}', " ")
        .replace('\u{00A0}', " ")
        .replace('\u{200B}', "")
        .replace('\u{FEFF}', "");
    cleaned = PARAGRAPH_TAG_RE.replace_all(&cleaned, "\n").to_string();
    cleaned = LINE_BREAK_TAG_RE.replace_all(&cleaned, "\n").to_string();
    cleaned = GENERIC_TAG_RE.replace_all(&cleaned, "").to_string();
    cleaned = NICKNAME_RE.replace_all(&cleaned, "博士").to_string();
    cleaned = cleaned.trim().to_string();

    if cleaned.contains('\n') {
        let normalized = cleaned
            .lines()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        return normalized;
    }

    cleaned
}

fn has_meaningful_content(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    if trimmed.len() <= 3 && trimmed.chars().all(|c| c.is_ascii_punctuation()) {
        return false;
    }

    if trimmed.chars().count() == 1 {
        let ch = trimmed.chars().next().unwrap();
        if ch.is_ascii_alphanumeric() && ch.is_ascii() {
            return false;
        }
        // 单个全角标点（`[Character(...)]。`、`[delay(time=1)]：` 的手滑残渣）
        // 跟单个 ASCII 标点一样是渣。单个 CJK 字（"咦"）仍算正文。
        if !ch.is_alphanumeric() {
            return false;
        }
    }

    true
}

fn parse_dialog_like(
    attrs: &HashMap<String, String>,
    remainder: &str,
    current_char_id: Option<&str>,
) -> Option<StorySegment> {
    let text = if remainder.is_empty() {
        attrs.get("text").map(|t| clean_text(t)).unwrap_or_default()
    } else {
        clean_text(remainder)
    };
    if !has_meaningful_content(&text) {
        return None;
    }

    // Prefer explicit name/head/avatarid from attrs; fall back to the most
    // recent [Character] declaration so dialog lines without their own speaker
    // still inherit context.
    let resolved = resolve_speaker(attrs);
    let (character_name, character_id) = match resolved {
        Some(name) => {
            let explicit_id = attrs
                .get("head")
                .or_else(|| attrs.get("name"))
                .or_else(|| attrs.get("avatarid"))
                .map(|s| normalize_char_id(s))
                .filter(|s| s.starts_with("char_"));
            // `head` / `avatarid` 写的是身份 id。它们存在却解析不出 `char_`
            // （多半是 `npc_` / `avg_`）就说明作者显式换了一个没有干员头像的
            // 说话人，此时回退继承上一条 [Character] 的 `char_` 头像必然
            // 张冠李戴。只有「只写了显示名」的行（charslot + `[Dialog(name=...)]`
            // 的新脚本惯用形态）才大概率与当前立绘同属一人，才值得回退。
            let has_explicit_identity =
                attrs.contains_key("head") || attrs.contains_key("avatarid");
            let character_id = explicit_id.or_else(|| {
                if has_explicit_identity {
                    None
                } else {
                    current_char_id.map(|s| s.to_string())
                }
            });
            (Some(name), character_id)
        }
        None => {
            // No explicit speaker attr on this command — try the current speaker
            // tracked from the last [Character] instruction.
            if let Some(cid) = current_char_id {
                // For display, try to humanize the charId; caller may replace
                // with localized name client-side via character_table.
                (Some(humanize_identifier(cid)), Some(cid.to_string()))
            } else {
                (None, None)
            }
        }
    };

    if let Some(name) = character_name {
        let position = attrs.get("isavatarright").and_then(|v| {
            if is_truthy(v) {
                Some("right".to_string())
            } else {
                None
            }
        });
        Some(StorySegment::Dialogue {
            character_name: name,
            text,
            position,
            character_id,
        })
    } else {
        Some(StorySegment::Narration { text })
    }
}

fn resolve_speaker(attrs: &HashMap<String, String>) -> Option<String> {
    if let Some(name) = attrs.get("name") {
        // 显示名是作者写死的字符串，`???` / `A` 这种也照用；只有空串算「没写」。
        let cleaned = normalize_speaker_name(name);
        if !cleaned.is_empty() {
            return Some(cleaned);
        }
    }

    if let Some(head) = attrs.get("head") {
        let cleaned = humanize_identifier(head);
        if has_meaningful_content(&cleaned) {
            return Some(cleaned);
        }
    }

    if let Some(avatar) = attrs.get("avatarid") {
        let cleaned = humanize_identifier(avatar);
        if has_meaningful_content(&cleaned) {
            return Some(cleaned);
        }
    }

    None
}

fn humanize_identifier(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"').trim_start_matches('$');
    // `char_130_doberm_ex` 不去掉 `_ex` 会显示成 "Doberm Ex"。
    let stripped = strip_art_variants(trimmed, 1).join("_");
    let mut value = stripped.as_str();
    for prefix in &[
        "char_", "npc_", "avg_", "avatar_", "trap_", "voice_", "item_", "act_", "story_",
    ] {
        if value.starts_with(prefix) {
            value = &value[prefix.len()..];
            break;
        }
    }

    let mut parts = value
        .split(|c| c == '_' || c == '#')
        .filter(|part| !part.trim().is_empty() && !part.chars().all(|c| c.is_ascii_digit()))
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => {
                    let mut s = first.to_uppercase().collect::<String>();
                    s.push_str(chars.as_str());
                    s
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>();

    if parts.is_empty() {
        return raw.trim().to_string();
    }

    parts.dedup();
    parts.join(" ")
}

fn is_truthy(val: &str) -> bool {
    let v = val.trim().to_ascii_lowercase();
    matches!(v.as_str(), "1" | "true" | "yes" | "y")
}

trait IfEmpty {
    fn if_empty_then(self, f: impl FnOnce() -> String) -> String;
}

impl IfEmpty for String {
    fn if_empty_then(self, f: impl FnOnce() -> String) -> String {
        if self.trim().is_empty() {
            f()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(parsed: &ParsedStoryContent) -> Vec<&'static str> {
        parsed.segments.iter().map(|s| s.kind()).collect()
    }

    fn texts(parsed: &ParsedStoryContent) -> Vec<&str> {
        parsed
            .segments
            .iter()
            .filter_map(|s| s.text())
            .collect()
    }

    fn only(content: &str) -> StorySegment {
        let mut parsed = parse_story_text(content);
        assert_eq!(
            parsed.segments.len(),
            1,
            "expected exactly one segment, got {:?}",
            parsed.segments
        );
        parsed.segments.remove(0)
    }

    #[test]
    fn test_parse_dialogue() {
        let content = r#"[name="杜宾"]  可恶......
[name="杜宾"]  这里，究竟怎么了？"#;

        let result = parse_story_text(content);
        assert_eq!(result.segments.len(), 2);

        match &result.segments[0] {
            StorySegment::Dialogue {
                character_name,
                text,
                ..
            } => {
                assert_eq!(character_name, "杜宾");
                assert_eq!(text, "可恶......");
            }
            _ => panic!("Expected dialogue segment"),
        }
    }

    #[test]
    fn test_parse_decision_variants() {
        let content = r#"[Decision(options="早就该交给我了！;......;简单，我会轻松解决的。", values="1;2;3")]
[Decision(option1="选项A", value1="1", option2="选项B", value2="2")]"#;

        let result = parse_story_text(content);
        assert_eq!(result.segments.len(), 2);

        match &result.segments[0] {
            StorySegment::Decision { options, .. } => {
                assert_eq!(options.len(), 3);
                assert_eq!(options[0], "早就该交给我了！");
                assert_eq!(options[1], "......");
                assert_eq!(options[2], "简单，我会轻松解决的。");
            }
            _ => panic!("Expected decision segment"),
        }

        match &result.segments[1] {
            StorySegment::Decision { options, .. } => {
                assert_eq!(options, &vec!["选项A".to_string(), "选项B".to_string()]);
            }
            _ => panic!("Expected decision segment"),
        }
    }

    #[test]
    fn test_parse_subtitle_and_system() {
        let content = r#"[Subtitle(text="“让所有人都站起来。”", alignment="center")]
[PopupDialog(dialogHead="$avatar_sys")] 请尽可能多地与其他组织建立良好关系"#;

        let result = parse_story_text(content);
        assert_eq!(result.segments.len(), 2);

        match &result.segments[0] {
            StorySegment::Subtitle { text, alignment } => {
                assert_eq!(text, "“让所有人都站起来。”");
                assert_eq!(alignment.as_deref(), Some("center"));
            }
            _ => panic!("Expected subtitle segment"),
        }

        match &result.segments[1] {
            StorySegment::System { speaker, text } => {
                assert_eq!(speaker.as_deref(), Some("Sys"));
                assert_eq!(text, "请尽可能多地与其他组织建立良好关系");
            }
            _ => panic!("Expected system segment"),
        }
    }

    #[test]
    fn test_parse_dialog_like_commands() {
        let content = r#"[Dialog(head="char_356_broca", delay=1)]橘子酱通心粉，我有点印象。
[VoiceWithin(head="npc_1028_texas2_1",delay=1)]把饭钱也给老板了，去别处走走吧。
[Narration]身处宪兵队的审讯室中，他的神情却出奇地平静。
[AnimText(id="at1")]<p=1>罗德岛医疗部</><p=2>1099年1月27日 11:38 A.M.</>
[Title] MAIN_LOG_102_1
[Div] Part.02
[avatarId="", isAvatarRight="FALSE"]警告：PRTS系统权限读写中......"#;

        let result = parse_story_text(content);
        assert_eq!(result.segments.len(), 7);

        match &result.segments[0] {
            StorySegment::Dialogue {
                character_name,
                text,
                ..
            } => {
                assert_eq!(character_name, "Broca");
                assert_eq!(text, "橘子酱通心粉，我有点印象。");
            }
            _ => panic!("Expected dialogue segment"),
        }

        match &result.segments[1] {
            StorySegment::Dialogue {
                character_name,
                text,
                ..
            } => {
                assert_eq!(character_name, "Texas2");
                assert!(text.contains("把饭钱也给老板了"));
            }
            _ => panic!("Expected dialogue segment"),
        }

        match &result.segments[2] {
            StorySegment::Narration { text } => {
                assert!(text.starts_with("身处宪兵队的审讯室"));
            }
            _ => panic!("Expected narration segment"),
        }

        match &result.segments[3] {
            StorySegment::Sticker { text, .. } => {
                assert!(text.contains("罗德岛医疗部"));
                assert!(text.contains("1099年1月27日"));
                assert!(text.contains("\n"));
            }
            _ => panic!("Expected sticker segment"),
        }

        match &result.segments[4] {
            StorySegment::Header { title } => {
                assert_eq!(title, "MAIN_LOG_102_1");
            }
            _ => panic!("Expected header segment"),
        }

        match &result.segments[5] {
            StorySegment::Subtitle { text, .. } => {
                assert_eq!(text, "Part.02");
            }
            _ => panic!("Expected subtitle segment"),
        }

        match &result.segments[6] {
            StorySegment::System { text, .. } => {
                assert!(text.contains("PRTS系统权限读写中"));
            }
            _ => panic!("Expected system segment"),
        }
    }

    #[test]
    fn test_parse_header_and_narration() {
        let content = r#"[HEADER(key="title", is_skippable=true)] 节标题
这一段是旁白。"#;

        let result = parse_story_text(content);
        assert_eq!(result.segments.len(), 2);

        match &result.segments[0] {
            StorySegment::Header { title } => {
                assert_eq!(title, "节标题");
            }
            _ => panic!("Expected header segment"),
        }

        match &result.segments[1] {
            StorySegment::Narration { text } => {
                assert_eq!(text, "这一段是旁白。");
            }
            _ => panic!("Expected narration segment"),
        }
    }

    #[test]
    fn test_normalize_char_id_strips_art_suffixes() {
        assert_eq!(normalize_char_id("char_345_folnic_1"), "char_345_folnic");
        assert_eq!(normalize_char_id("char_002_amiya_1#5"), "char_002_amiya");
        assert_eq!(normalize_char_id("char_130_doberm_ex"), "char_130_doberm");
        assert_eq!(normalize_char_id("char_003_kalts"), "char_003_kalts");
    }

    #[test]
    fn test_charslot_updates_current_speaker() {
        let content = r#"[charslot(slot="m",name="char_003_kalts_1")]
[Dialog] 我是凯尔希。"#;
        let result = parse_story_text(content);
        assert_eq!(result.segments.len(), 1);
        match &result.segments[0] {
            StorySegment::Dialogue {
                character_id,
                text,
                ..
            } => {
                assert_eq!(character_id.as_deref(), Some("char_003_kalts"));
                assert!(text.contains("凯尔希"));
            }
            _ => panic!("Expected dialogue segment from charslot + Dialog"),
        }
    }

    #[test]
    fn test_normalize_char_id_handles_dollar_and_stacked_variants() {
        // `#4` 是表情差分，`$1` 是同一张立绘的第二套动作，都不换人。
        assert_eq!(normalize_char_id("char_290_vigna_1#1$1"), "char_290_vigna");
        assert_eq!(normalize_char_id("char_002_amiya$2"), "char_002_amiya");
        assert_eq!(normalize_char_id("char_1012_skadi2_1"), "char_1012_skadi2");
        // 非 char_ 的 id 原样留着，前端只拿 char_ 拼头像。
        assert_eq!(normalize_char_id("npc_1028_texas2_1"), "npc_1028_texas2_1");
        assert_eq!(normalize_char_id(""), "");
    }

    /// 演出指令一条都不该落进正文；只要还有一条被当成旁白印出来，
    /// 阅读器里就会冒出 `avg_xxx` / `fx_snow` 这种素材名。
    #[test]
    fn test_stage_directions_never_leak_into_text() {
        let content = r#"[Background(image="bg_rhodes_office", screenadapt="coverall", fadetime=1)]
[BackgroundTween(fadetime=1)]
[bgeffect(name="rain")]
[largebg(imagegroup="g_13", screenadapt="coverall")]
[CameraShake(duration=1, xstrength=10, ystrength=0, vibrato=10, fadeout=true, block=true)]
[cameraScale(scale=1.2, duration=0.5)]
[Effect(name="fx_snow", x=0.5, y=0.5)]
[StopEffect(name="fx_snow")]
[Curtain(alpha=1, fadetime=1)]
[Blocker(a=1, r=0, g=0, b=0, block=true, fadetime=1.5)]
[Delay(time=1)]
[StopMusic(fadetime=3)]
[PlaySound(key="$door_open", volume=0.8, channel=1)]
[StopSound(channel=1, fadetime=0.5)]
[Musicvolume(volume=0.3, fadetime=1)]
[Soundvolume(volume=0.3)]
[PlayVideo(name="avg_video_01", loop=false)]
[Gallery(id="g_13_I01")]
[ShowItem(id="item_token")]
[Predicate(references="op1;op2")]
[SkipToNode(node="node_2")]
[dialogtransition(fadetime=0.3)]
[characteraction(name="char_003_kalts_1", action="nod")]
[chartilt(angle=5)]
[stickerclear]
[charslot]
[dialog]"#;

        let result = parse_story_text(content);
        assert!(
            result.segments.is_empty(),
            "stage directions leaked as text: {:?}",
            result.segments
        );
    }

    /// 兜底分支不能把演出指令的素材名当旁白——但真跟在指令后面的文字要留住。
    #[test]
    fn test_trailing_prose_survives_a_stage_direction() {
        let content = r#"[Delay(time=1)]天亮了。
[Effect(name="fx_snow")]"#;
        let result = parse_story_text(content);
        assert_eq!(kinds(&result), vec!["narration"]);
        assert_eq!(texts(&result), vec!["天亮了。"]);
    }

    /// 不认识的指令若把正文塞在 `text=` 里，也得捞出来，否则整句消失。
    #[test]
    fn test_unknown_command_falls_back_to_text_attribute() {
        let segment = only(r#"[Announce(text="紧急广播：全体撤离。", delay=1)]"#);
        assert_eq!(segment.kind(), "narration");
        assert_eq!(segment.text(), Some("紧急广播：全体撤离。"));
    }

    /// `[` 开头但没有闭合方括号的行是正文，不是残缺指令。
    #[test]
    fn test_unclosed_bracket_line_is_kept_as_narration() {
        let result = parse_story_text("[未闭合的一行台词\n[name=\"杜宾\"]正常台词。");
        assert_eq!(kinds(&result), vec!["narration", "dialogue"]);
        assert_eq!(texts(&result), vec!["[未闭合的一行台词", "正常台词。"]);
    }

    /// `[Character(...)][name="A"]台词` 写在同一行时，状态指令只能吃掉自己
    /// 那一段，后面的台词必须照常解析。
    #[test]
    fn test_state_command_prefix_does_not_eat_the_rest_of_the_line() {
        let content =
            r#"[Character(name="char_002_amiya_1#4")][name="阿米娅"]博士，我们该出发了。"#;
        let segment = only(content);
        assert_eq!(segment.speaker(), Some("阿米娅"));
        assert_eq!(segment.text(), Some("博士，我们该出发了。"));
    }

    /// `focus=2` 说明说话的是 `name2` 那位立绘。
    #[test]
    fn test_character_focus_picks_the_second_slot() {
        let content = r#"[Character(name="char_290_vigna_1#1$1",name2="char_130_doberm_1#4",fadetime=0.7,focus=2)]
[Dialog]立正！"#;
        let segment = only(content);
        assert_eq!(segment.character_id(), Some("char_130_doberm"));

        let content = r#"[Character(name="char_290_vigna_1#1$1",name2="char_130_doberm_1#4",focus=1)]
[Dialog]是。"#;
        let segment = only(content);
        assert_eq!(segment.character_id(), Some("char_290_vigna"));
    }

    /// 显示名是标签不是正文：富文本、`{@nickname}`、多余空白都得抹平，
    /// 不然同一个角色会在搜索里散成好几个人。
    #[test]
    fn test_speaker_names_are_normalized() {
        let segment = only(r#"[name="{@nickname}"]我在。"#);
        assert_eq!(segment.speaker(), Some("博士"));

        let segment = only(r#"[name="<color=#f00>杜宾</>"]集合！"#);
        assert_eq!(segment.speaker(), Some("杜宾"));

        let segment = only("[name=\"Rhodes\\n  Island\"]我们是罗德岛。");
        assert_eq!(segment.speaker(), Some("Rhodes Island"));

        // `[Dialog(head=...)]` 与 `[name=...]` 走同一套归一化，异格后缀不外泄。
        let segment = only(r#"[Dialog(head="char_130_doberm_ex")]口令。"#);
        assert_eq!(segment.speaker(), Some("Doberm"));

        // `[PopupDialog]` 的 dialogHead 同理。
        let segment = only(r#"[PopupDialog(dialogHead="$avatar_prts_1")]系统提示。"#);
        assert_eq!(segment.kind(), "system");
        assert_eq!(segment.speaker(), Some("Prts"));
    }

    /// 空名字仍旧是场景字幕，`???` 这种作者故意写的名字要原样保留。
    #[test]
    fn test_empty_name_is_subtitle_but_placeholder_names_survive() {
        let segment = only(r#"[name=""]罗德岛，深夜。"#);
        assert_eq!(segment.kind(), "subtitle");
        assert_eq!(segment.text(), Some("罗德岛，深夜。"));

        let segment = only(r#"[name="???"]你是谁？"#);
        assert_eq!(segment.kind(), "dialogue");
        assert_eq!(segment.speaker(), Some("???"));
    }

    /// `[multiline]` 续行常省略 `name`；宁可降级成旁白，也不能整段丢掉。
    #[test]
    fn test_multiline_without_name_keeps_the_text() {
        let content = r#"[multiline(name="凯尔希", delay=1)]这件事，
[multiline(end=true)]你迟早要知道。"#;
        let result = parse_story_text(content);
        assert_eq!(kinds(&result), vec!["dialogue", "narration"]);
        assert_eq!(result.segments[0].speaker(), Some("凯尔希"));
        assert_eq!(texts(&result), vec!["这件事，", "你迟早要知道。"]);
    }

    /// 无引号属性（`focus=2`、`image=avg_1`）以前整条看不见。
    #[test]
    fn test_unquoted_attributes_are_parsed() {
        let attrs = parse_attributes(r#"Image(image=avg_8_34, fadetime=2, caption="雪原")"#);
        assert_eq!(attrs.get("image").map(String::as_str), Some("avg_8_34"));
        assert_eq!(attrs.get("fadetime").map(String::as_str), Some("2"));
        assert_eq!(attrs.get("caption").map(String::as_str), Some("雪原"));
        // 空串仍是「写了但为空」，不能被无引号分支吞掉。
        let attrs = parse_attributes(r#"avatarId="", isAvatarRight="FALSE""#);
        assert_eq!(attrs.get("avatarid").map(String::as_str), Some(""));
    }

    #[test]
    fn test_image_and_music_segments() {
        let content = r#"[Image(image="avg_8_34", screenadapt="coverall", fadetime=2)]
[PlayMusic(intro="$drift_intro", key="$drift_loop", volume=0.6)]
[Image(screenadapt="coverall")]"#;
        let result = parse_story_text(content);
        assert_eq!(kinds(&result), vec!["image", "music"]);
        match &result.segments[0] {
            StorySegment::Image { token, caption } => {
                assert_eq!(token, "avg_8_34");
                assert!(caption.is_none());
            }
            other => panic!("expected image segment, got {:?}", other),
        }
        match &result.segments[1] {
            StorySegment::Music { key } => assert_eq!(key, "$drift_loop"),
            other => panic!("expected music segment, got {:?}", other),
        }
    }

    /// 富文本、换行转义、零宽字符都不该出现在正文里。
    #[test]
    fn test_clean_text_normalizes_markup_and_whitespace() {
        assert_eq!(clean_text(r"第一行\n第二行"), "第一行\n第二行");
        assert_eq!(clean_text("第一行<br>第二行"), "第一行\n第二行");
        assert_eq!(clean_text("第一行<br />第二行"), "第一行\n第二行");
        assert_eq!(clean_text("<size=40>大字</>"), "大字");
        assert_eq!(clean_text("你好\u{200B}，博士"), "你好，博士");
        assert_eq!(clean_text("\u{3000}前置全角空格"), "前置全角空格");
        assert_eq!(clean_text("{@NickName}，早上好"), "博士，早上好");
        // 空行会被折掉，段落之间只留一个换行。
        assert_eq!(clean_text(r"上\n\n\n下"), "上\n下");
    }

    #[test]
    fn test_decision_keeps_option_values_paired() {
        let segment = only(r#"[Decision(options="走;留", values="1;2")]"#);
        match segment {
            StorySegment::Decision { options, values } => {
                assert_eq!(options, vec!["走".to_string(), "留".to_string()]);
                assert_eq!(values, vec!["1".to_string(), "2".to_string()]);
            }
            other => panic!("expected decision segment, got {:?}", other),
        }
        // 一个选项都解析不出来时不产出空的选择段。
        assert!(parse_story_text(r#"[Decision(values="1;2")]"#).segments.is_empty());
    }

    /// 前端按 `values[optionIndex]` 逐位取标签：option/value 必须按下标配对。
    /// 乱序、跳号、空选项、数量不等都不能把 value 平移到别的选项头上。
    #[test]
    fn test_decision_options_pair_values_by_index() {
        // 编号形态乱序 + 跳号：按数字下标配对，不按「第几个出现」。
        let segment =
            only(r#"[Decision(option3="慢慢来", value3="3", option1="立刻出发", value1="1")]"#);
        match segment {
            StorySegment::Decision { options, values } => {
                assert_eq!(options, vec!["立刻出发".to_string(), "慢慢来".to_string()]);
                assert_eq!(values, vec!["1".to_string(), "3".to_string()]);
            }
            other => panic!("expected decision segment, got {:?}", other),
        }

        // 分号形态的空选项连同它自己的 value 一起丢，后面的选项不平移。
        let segment = only(r#"[Decision(options="走;;留", values="1;2;3")]"#);
        match segment {
            StorySegment::Decision { options, values } => {
                assert_eq!(options, vec!["走".to_string(), "留".to_string()]);
                assert_eq!(values, vec!["1".to_string(), "3".to_string()]);
            }
            other => panic!("expected decision segment, got {:?}", other),
        }

        // 数量不等：缺 value 的选项用空串占位（前端把空串当没有），不平移。
        let segment = only(r#"[Decision(options="走;留;再想想", values="1;2")]"#);
        match segment {
            StorySegment::Decision { options, values } => {
                assert_eq!(options.len(), 3);
                assert_eq!(
                    values,
                    vec!["1".to_string(), "2".to_string(), String::new()]
                );
            }
            other => panic!("expected decision segment, got {:?}", other),
        }

        // 编号形态缺某个下标的 value 同理：option1 拿空串，option2 拿 value2。
        let segment = only(r#"[Decision(option1="A", option2="B", value2="2")]"#);
        match segment {
            StorySegment::Decision { options, values } => {
                assert_eq!(options, vec!["A".to_string(), "B".to_string()]);
                assert_eq!(values, vec![String::new(), "2".to_string()]);
            }
            other => panic!("expected decision segment, got {:?}", other),
        }
    }

    /// values 比 options 多（level_main_15-18_end 等 10 个文件的
    /// `options="时间应该快到了。", values="1;2"`）：多余的 value 直接忽略，
    /// 仅剩的选项仍按自己的下标拿 value，不能错位也不能产出多余项。
    #[test]
    fn test_decision_extra_values_are_ignored() {
        let segment = only(r#"[Decision(options="时间应该快到了。", values="1;2")]"#);
        match segment {
            StorySegment::Decision { options, values } => {
                assert_eq!(options, vec!["时间应该快到了。".to_string()]);
                assert_eq!(values, vec!["1".to_string()]);
            }
            other => panic!("expected decision segment, got {:?}", other),
        }
    }

    /// 场景切换后 `[Character]` 状态要跟着走；清空后不能把上一位的头像
    /// 继续挂到无主对白上。
    #[test]
    fn test_speaker_state_is_replaced_and_cleared() {
        let content = r#"[Character(name="char_003_kalts_1")]
[Dialog]第一句。
[Character(name="char_002_amiya_1")]
[Dialog]第二句。
[Character]
[Dialog]第三句。"#;
        let result = parse_story_text(content);
        assert_eq!(kinds(&result), vec!["dialogue", "dialogue", "narration"]);
        assert_eq!(result.segments[0].character_id(), Some("char_003_kalts"));
        assert_eq!(result.segments[1].character_id(), Some("char_002_amiya"));
        assert_eq!(result.segments[2].character_id(), None);
    }

    /// `[Dialog(head="npc_...")]` 显式指明说话人不是干员时，绝不能继承上一条
    /// `[Character]` 留下的 `char_` 头像（下游还会把它带进同名对白合并）；
    /// 但只写显示名的 `[Dialog(name=...)]`（charslot 新脚本惯用形态）仍要
    /// 回退，否则这类对白整段丢头像。
    #[test]
    fn test_explicit_npc_head_does_not_inherit_stale_char_id() {
        let content = r#"[Character(name="char_003_kalts_1")]
[Dialog(head="npc_1028_texas2_1")]她不会回来了。
[Dialog(name="凯尔希")]我知道。
[Dialog]回去吧。"#;
        let result = parse_story_text(content);
        assert_eq!(kinds(&result), vec!["dialogue", "dialogue", "dialogue"]);
        // NPC head 显式换人：不许挂上凯尔希的头像。
        assert_eq!(result.segments[0].speaker(), Some("Texas2"));
        assert_eq!(result.segments[0].character_id(), None);
        // 只写显示名：大概率就是当前立绘本人，保留回退。
        assert_eq!(result.segments[1].speaker(), Some("凯尔希"));
        assert_eq!(result.segments[1].character_id(), Some("char_003_kalts"));
        // 什么都没写：完全继承状态。
        assert_eq!(result.segments[2].character_id(), Some("char_003_kalts"));
    }

    /// `[name=...]` 的显示名是权威来源，不继承上一条 `[Character]` 的 charId：
    /// 多人同场时脚本经常不翻立绘就换说话人。
    #[test]
    fn test_name_command_does_not_inherit_character_id() {
        let content = r#"[Character(name="char_003_kalts_1")]
[name="阿米娅"]凯尔希医生说得对。"#;
        let segment = only(content);
        assert_eq!(segment.speaker(), Some("阿米娅"));
        assert_eq!(segment.character_id(), None);
    }

    /// 引号里的 `]` 是属性值不是指令结束（真实数据 story_cetsyr_1_1.txt）：
    /// 在它身上截断，`text` 属性就解析不出来，整条贴纸文字消失。
    #[test]
    fn test_bracket_inside_quoted_attr_does_not_truncate_command() {
        let segment = only(
            r#"[Sticker(id="st1", multi = true, text="\n_与节点[DWDB-221E]建立交叉验证连接（授权码：CE）",delay=0.05, block = true)]"#,
        );
        assert_eq!(segment.kind(), "sticker");
        assert_eq!(
            segment.text(),
            Some("_与节点[DWDB-221E]建立交叉验证连接（授权码：CE）")
        );

        // 演出指令属性里的 `[hidden]`（sandbox 脚本）也不能把 `")]` 漏成正文。
        let parsed = parse_story_text(
            r#"[executeactionarray(target="trap_470_tmantic", key="effect_mantic[hidden]")]"#,
        );
        assert!(parsed.segments.is_empty(), "leaked: {:?}", parsed.segments);
    }

    /// act15mini 有一批单引号属性（`[name='麦哲伦']`），不认单引号就会把
    /// `'麦哲伦'` 连引号一起显示成说话人，头像反查也跟着失败。
    #[test]
    fn test_single_quoted_attributes_are_parsed() {
        let segment = only(r#"[name='麦哲伦']呃，之前，在哨所里的时候，我一时兴奋。"#);
        assert_eq!(segment.kind(), "dialogue");
        assert_eq!(segment.speaker(), Some("麦哲伦"));
        assert_eq!(
            segment.text(),
            Some("呃，之前，在哨所里的时候，我一时兴奋。")
        );

        // 双引号值里的撇号不受单引号分支影响。
        let attrs = parse_attributes(r#"Subtitle(text="it's fine", alignment='center')"#);
        assert_eq!(attrs.get("text").map(String::as_str), Some("it's fine"));
        assert_eq!(attrs.get("alignment").map(String::as_str), Some("center"));
    }

    /// 状态指令后面粘着的数据残次（`[character]]` 的多余 `]`、`[charslot(...)]4`
    /// 的手滑字符）不能泄漏成孤零零的旁白段；独立成行的 `...`（幽灵鲨的歌声
    /// 淡出，act17side）是有意写的正文，必须保留。
    #[test]
    fn test_state_command_trailing_junk_does_not_leak() {
        let content = "[character]]\n[charslot(slot = \"m\", afrom=1,ato=0, duration = 0.5)]z\n[Character(name=\"char_010_chen_1\", name2=\"char_012_misa_1\", focus=1)]=";
        let result = parse_story_text(content);
        assert!(
            result.segments.is_empty(),
            "state-command junk leaked: {:?}",
            result.segments
        );

        let result = parse_story_text("......\n...");
        assert_eq!(kinds(&result), vec!["narration", "narration"]);
        assert_eq!(texts(&result), vec!["......", "..."]);

        // 真实数据里的 CJK 残渣：level_main_12-17_end 的编辑批注 `已改`、
        // story_blackd_2_1 的手滑 `我`。它们是合法文字，单靠
        // has_meaningful_content 拦不住，会漏成孤立旁白。
        assert!(parse_story_text(
            r#"[charslot(slot="r",name="avg_4087_ines_1#1$1",focus="r")]已改"#
        )
        .segments
        .is_empty());
        assert!(parse_story_text(
            r#"[charslot(slot = "m", name = "avg_198_blackd_1#6$1")]我"#
        )
        .segments
        .is_empty());
    }

    /// 全角标点残渣同样不能漏成孤立段落：act18d3/act3d0 等 6 个文件有
    /// `[Character(...)]。`，story_malist_1_1 有 `[delay(time=1)]：`。
    /// act21side task 文本的 `[dialog(...)]......` 是有意的沉默对白，必须保留。
    #[test]
    fn test_fullwidth_punctuation_junk_does_not_leak() {
        assert!(parse_story_text(r#"[Character(name="avg_npc_182#2")]。"#)
            .segments
            .is_empty());
        assert!(
            parse_story_text(r#"[charslot(slot = "m", name = "avg_4140_lasher_1#1$1")]。"#)
                .segments
                .is_empty()
        );
        assert!(parse_story_text("[delay(time=1)]：").segments.is_empty());

        let segment = only(r#"[dialog(head="npc_698_1",delay=1,style="other")]......"#);
        assert_eq!(segment.kind(), "dialogue");
        assert_eq!(segment.text(), Some("......"));

        // 有名字的纯标点台词（`[name="斯卡蒂"]！！`）是有意写的。
        let segment = only(r#"[name="斯卡蒂"]！！"#);
        assert_eq!(segment.text(), Some("！！"));
    }

    /// 不带任何属性的 `[dialog]......`（act21side 任务文本）是有意的沉默
    /// 对白：有 `[Character]` 状态时挂当前立绘，什么状态都没有时也至少要
    /// 以旁白留下，不能整行蒸发。
    #[test]
    fn test_bare_dialog_silence_is_kept() {
        let content = "[Character(name=\"char_1012_skadi2_1\")]\n[dialog]......";
        let segment = only(content);
        assert_eq!(segment.kind(), "dialogue");
        assert_eq!(segment.text(), Some("......"));
        assert_eq!(segment.character_id(), Some("char_1012_skadi2"));

        let segment = only("[dialog]......");
        assert_eq!(segment.kind(), "narration");
        assert_eq!(segment.text(), Some("......"));
    }

    /// `[Subtitle]` / `[Sticker]` 的正文可能写在 `]` 后面而不是 `text=` 里，
    /// 不能整句丢掉；反过来，清屏用的裸指令、空 `text=`、手滑残渣也绝不能
    /// 产出空段或渣段。
    #[test]
    fn test_subtitle_and_sticker_keep_trailing_text_and_never_emit_empty() {
        let segment = only(r#"[Subtitle(alignment="center")]七日之后"#);
        assert_eq!(segment.kind(), "subtitle");
        assert_eq!(segment.text(), Some("七日之后"));

        let segment = only("[Sticker] 档案编号：0021");
        assert_eq!(segment.kind(), "sticker");
        assert_eq!(segment.text(), Some("档案编号：0021"));

        // `text=` 属性仍是权威来源，remainder 只是兜底。
        let segment = only(r#"[Sticker(text="正文在属性里")]"#);
        assert_eq!(segment.text(), Some("正文在属性里"));

        for junk in [
            "[Subtitle]",
            "[Sticker]",
            r#"[Subtitle(text="")]"#,
            r#"[Sticker(text="", delay=0.5)]"#,
            "[Sticker]。",
            "[Subtitle]4",
        ] {
            assert!(
                parse_story_text(junk).segments.is_empty(),
                "empty/junk overlay leaked for {junk:?}: {:?}",
                parse_story_text(junk).segments
            );
        }
    }

    /// `[PopupDialog(...)] 呵。` 这类 ≤2 字符的短正文是有意的台词（真实数据
    /// main_08-05 的「呵。」、training_18_a 的「呃。」、training_act18d3_01_e
    /// 的「是！」，全语料共 4 处、无一是渣）：popupdialog/tutorial 分支只做
    /// 非空检查，绝不能套用状态指令那套「≤2 字符当残渣丢弃」的门槛。
    #[test]
    fn test_popupdialog_short_dialogue_is_kept() {
        let segment = only(r#"[PopupDialog(dialogHead="$avatar_frstar")] 呵。"#);
        assert_eq!(segment.kind(), "system");
        assert_eq!(segment.speaker(), Some("Frstar"));
        assert_eq!(segment.text(), Some("呵。"));

        let segment = only(r#"[PopupDialog(dialogHead="system_100_mys")] 是！"#);
        assert_eq!(segment.kind(), "system");
        assert_eq!(segment.text(), Some("是！"));

        // 空 `[]`（story_cement_1_1 的手滑行）走兜底分支安静消失，不产段。
        assert!(parse_story_text("[]").segments.is_empty());
    }

    /// 教程/训练脚本把一条指令用行尾 `\` 折成多行（真实数据 training_8_b.txt、
    /// 316 个文件共 1975 行）。不拼回逻辑行的话：属性续行漏成旁白、孤 `\`
    /// 变成正文、教程文字跟 dialogHead 说话人拆散。
    #[test]
    fn test_backslash_continuation_joins_multiline_commands() {
        let content = r#"[PopupDialog(focusX=362, focusY=-147, focusWidth=116, focusHeight=130, \
          animStyle="Highlight", focusStyle="HighlightCircle", black="$f_tut_black", \
          protectTime=0.5, dialogHead="$avatar_doberm")] \
敌人似乎已经发现了我方人手不足的弱点，准备兵分两路发动进攻。"#;
        let segment = only(content);
        assert_eq!(segment.kind(), "system");
        assert_eq!(segment.speaker(), Some("Doberm"));
        assert_eq!(
            segment.text(),
            Some("敌人似乎已经发现了我方人手不足的弱点，准备兵分两路发动进攻。")
        );

        // 单行指令 + `\` + 下一行正文（training_8_b.txt 的常见形态）。
        let content = r#"[PopupDialog(dialogHead="$avatar_jesica")] \
啊对了！这些障碍物可以封锁敌人的前进道路。"#;
        let segment = only(content);
        assert_eq!(segment.kind(), "system");
        assert_eq!(segment.speaker(), Some("Jesica"));
        assert_eq!(segment.text(), Some("啊对了！这些障碍物可以封锁敌人的前进道路。"));
    }

    /// 手势教程（training_28_f.txt）`[Tutorial(...)] \` 后面直接空行：没有
    /// 正文，续行必须在空行终止，不能把下一条指令吞成教程文字。
    #[test]
    fn test_backslash_continuation_stops_at_blank_line() {
        let content = "[Tutorial(waitForSignal=\"select_direction\", animStyle=\"Drag\", startTileX=6, startTileY=3, endTileX=6, endTileY=1)] \\\n\n[battle.unlockfunction(mask=\"SYSTEM_MENU_INTERACT\")]";
        let result = parse_story_text(content);
        assert!(
            result.segments.is_empty(),
            "gesture tutorial leaked: {:?}",
            result.segments
        );

        // 正文行以 `\` 收尾不是续行（只有指令行才认续行），原样保留。
        let result = parse_story_text("路牌上写着：出口 \\\n下一行是别的旁白。");
        assert_eq!(kinds(&result), vec!["narration", "narration"]);
    }

    /// `[Tutorial(...)] \` 后面不留空行、直接跟下一条指令时，指令行必须
    /// 终止续行：否则那条指令的原文会漏成教程正文，指令本身（可能是一句
    /// 对白）也被吞掉。
    #[test]
    fn test_backslash_continuation_does_not_eat_next_command() {
        let content =
            "[Tutorial(waitForSignal=\"place_char\", animStyle=\"Drag\")] \\\n[Blocker(a=0, fadetime=0.5)]";
        let result = parse_story_text(content);
        assert!(
            result.segments.is_empty(),
            "next command was eaten into tutorial text: {:?}",
            result.segments
        );

        // 被粘住的下一条指令若是对白，必须照常解析出来。
        let content = "[PopupDialog(dialogHead=\"$avatar_doberm\")] \\\n[name=\"杜宾\"]全体集合！";
        let segment = only(content);
        assert_eq!(segment.kind(), "dialogue");
        assert_eq!(segment.speaker(), Some("杜宾"));
        assert_eq!(segment.text(), Some("全体集合！"));

        // 终止续行的指令行自己也可以又是一条续行的开头。
        let content = "[Tutorial(animStyle=\"Drag\")] \\\n[PopupDialog(dialogHead=\"$avatar_jesica\")] \\\n部署完毕后点击确认。";
        let segment = only(content);
        assert_eq!(segment.kind(), "system");
        assert_eq!(segment.speaker(), Some("Jesica"));
        assert_eq!(segment.text(), Some("部署完毕后点击确认。"));
    }

    /// 端到端跑一段贴近真实脚本的片段：段落种类和顺序都要稳。
    #[test]
    fn test_realistic_script_excerpt_shape() {
        let content = r#"[HEADER(key="title", is_skippable=true, fit_mode="BLACK_MASK")] 第一章
[Background(image="bg_rhodes_office", screenadapt="coverall")]
[PlayMusic(intro="$office_intro", key="$office_loop")]
[Subtitle(text="罗德岛，指挥室", alignment="center", delay=1)]
[Character(name="char_003_kalts_1#4")]
[name="凯尔希"]博士，你终于醒了。
[Delay(time=1)]
[charslot(slot="m", name="char_002_amiya_1")]
[Dialog]博士！
[Decision(options="我没事;再让我睡会儿", values="1;2")]
[Image(image="avg_10_1")]
[Blocker(a=1, fadetime=1)]
这是一段没有指令的旁白。"#;

        let result = parse_story_text(content);
        assert_eq!(
            kinds(&result),
            vec![
                "header",
                "music",
                "subtitle",
                "dialogue",
                "dialogue",
                "decision",
                "image",
                "narration",
            ]
        );
        assert_eq!(result.segments[3].speaker(), Some("凯尔希"));
        assert_eq!(result.segments[3].character_id(), None);
        assert_eq!(result.segments[4].character_id(), Some("char_002_amiya"));
        assert_eq!(result.segments[7].text(), Some("这是一段没有指令的旁白。"));
    }
}
