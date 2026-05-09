use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use unicode_normalization::UnicodeNormalization;
use zip::ZipArchive;

use crate::models::{
    Activity, Chapter, SearchDebugResponse, SearchResult, SearchResultsPage, StoryCategory,
    StoryEntry, StoryIndexStatus, StorySegment,
};
use crate::parser::parse_story_text;

const REPO_API_URL: &str = "https://api.github.com/repos/Kengxxiao/ArknightsGameData";
const REPO_DOWNLOAD_URL: &str = "https://codeload.github.com/Kengxxiao/ArknightsGameData/zip";
const DEFAULT_BRANCH: &str = "master";
const VERSION_FILE: &str = "version.json";
const SEARCH_RESULT_LIMIT: usize = 500;
const INDEX_VERSION: i32 = 2; // bump when FTS schema changes

#[derive(Clone, serde::Serialize)]
struct SyncProgress {
    phase: String,
    current: usize,
    total: usize,
    message: String,
}

#[derive(Clone, serde::Serialize)]
pub struct SearchProgress {
    phase: String,
    current: usize,
    total: usize,
    message: String,
}

#[derive(Clone, serde::Serialize)]
pub struct IndexProgress {
    phase: String,
    current: usize,
    total: usize,
    message: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct VersionInfo {
    commit: String,
    fetched_at: i64,
}

#[derive(Clone)]
struct IndexedStory {
    category_name: String,
    entry_type: String,
    story: StoryEntry,
}

fn emit_progress(
    app: &AppHandle,
    phase: impl Into<String>,
    current: usize,
    total: usize,
    message: impl Into<String>,
) {
    let progress = SyncProgress {
        phase: phase.into(),
        current,
        total,
        message: message.into(),
    };
    let _ = app.emit("sync-progress", progress);
}

fn emit_search_progress(
    app: &AppHandle,
    phase: impl Into<String>,
    current: usize,
    total: usize,
    message: impl Into<String>,
) {
    let progress = SearchProgress {
        phase: phase.into(),
        current,
        total,
        message: message.into(),
    };
    let _ = app.emit("search-progress", progress);
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    if !dst.exists() {
        fs::create_dir_all(dst)
            .map_err(|e| format!("Failed to create directory {:?}: {}", dst, e))?;
    }

    for entry in
        fs::read_dir(src).map_err(|e| format!("Failed to read directory {:?}: {}", src, e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type: {}", e))?;
        let dest_path = dst.join(entry.file_name());

        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &dest_path)?;
        } else {
            fs::copy(entry.path(), &dest_path)
                .map_err(|e| format!("Failed to copy file {:?}: {}", entry.path(), e))?;
        }
    }

    Ok(())
}

fn is_common_punctuation(ch: char) -> bool {
    if ch.is_ascii_punctuation() {
        return true;
    }

    matches!(
        ch,
        '，' | '、'
            | '。'
            | '！'
            | '？'
            | '：'
            | '；'
            | '（'
            | '）'
            | '【'
            | '】'
            | '「'
            | '」'
            | '『'
            | '』'
            | '《'
            | '》'
            | '〈'
            | '〉'
            | '—'
            | '～'
            | '…'
            | '·'
            | '﹑'
            | '﹔'
            | '﹗'
            | '﹖'
            | '﹐'
            | '﹒'
            | '﹕'
            | '︰'
    )
}

fn is_cjk(ch: char) -> bool {
    // Basic + Ext A/B ranges (not exhaustive but sufficient here)
    (ch >= '\u{4E00}' && ch <= '\u{9FFF}') // CJK Unified Ideographs
        || (ch >= '\u{3400}' && ch <= '\u{4DBF}') // Extension A
        || (ch >= '\u{20000}' && ch <= '\u{2A6DF}') // Extension B
        || (ch >= '\u{2A700}' && ch <= '\u{2B73F}')
        || (ch >= '\u{2B740}' && ch <= '\u{2B81F}')
        || (ch >= '\u{2B820}' && ch <= '\u{2CEAF}')
}

fn normalize_nfkc_lower_strip_marks(text: &str) -> String {
    // NFKC + lowercase + strip combining marks (e.g., café -> cafe)
    text.nfkc()
        .flat_map(|c| c.to_lowercase())
        .filter(|c| unicode_normalization::char::canonical_combining_class(*c) == 0)
        .collect()
}

/// Aggressive normalization for fuzzy matching: NFKC + lowercase + strip marks
/// + replace `{@nickname}` → `博士` + drop all whitespace / common punctuation.
/// Used by the linear-scan fallback and by context extraction to keep index and
/// raw-file search paths consistent (bug A3 / A2).
fn normalize_for_fuzzy(text: &str) -> String {
    let replaced = text.replace("{@nickname}", "博士");
    normalize_nfkc_lower_strip_marks(&replaced)
        .chars()
        .filter(|ch| !ch.is_whitespace() && !is_common_punctuation(*ch))
        .collect()
}

/// Split a raw user query into logical terms for AND matching in the fallback
/// scanner. Quoted phrases are kept intact; the leading `-` marks NOT (ignored
/// in fallback — fallback is advisory, not exhaustive). Returns already
/// fuzzy-normalized terms.
fn split_query_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut buf = String::new();
    let mut in_quotes = false;
    for ch in query.chars() {
        match ch {
            '"' => {
                if in_quotes {
                    if !buf.is_empty() {
                        let normalized = normalize_for_fuzzy(&buf);
                        if !normalized.is_empty() {
                            terms.push(normalized);
                        }
                        buf.clear();
                    }
                    in_quotes = false;
                } else {
                    if !buf.is_empty() {
                        let normalized = normalize_for_fuzzy(&buf);
                        if !normalized.is_empty() {
                            terms.push(normalized);
                        }
                        buf.clear();
                    }
                    in_quotes = true;
                }
            }
            c if c.is_whitespace() && !in_quotes => {
                if !buf.is_empty() {
                    let normalized = normalize_for_fuzzy(&buf);
                    if !normalized.is_empty() {
                        terms.push(normalized);
                    }
                    buf.clear();
                }
            }
            _ => buf.push(ch),
        }
    }
    if !buf.is_empty() {
        let normalized = normalize_for_fuzzy(&buf);
        if !normalized.is_empty() {
            terms.push(normalized);
        }
    }

    // Drop OR/NOT keywords and NOT prefixes — fallback only matches positive terms.
    terms
        .into_iter()
        .filter_map(|t| {
            if t == "or" {
                None
            } else if let Some(rest) = t.strip_prefix('-') {
                if rest.is_empty() {
                    None
                } else {
                    // Preserve as a positive term — NOT semantics handled only by FTS path.
                    Some(rest.to_string())
                }
            } else {
                Some(t)
            }
        })
        .collect()
}

fn extract_numeric_parts(text: &str) -> Vec<i32> {
    let mut parts = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        if ch.is_ascii_digit() {
            current.push(ch);
        } else if !current.is_empty() {
            if let Ok(num) = current.parse::<i32>() {
                parts.push(num);
            }
            current.clear();
        }
    }

    if !current.is_empty() {
        if let Ok(num) = current.parse::<i32>() {
            parts.push(num);
        }
    }

    parts
}

fn compare_story_group_ids(a: &str, b: &str) -> Ordering {
    let mut a_parts = extract_numeric_parts(a);
    let mut b_parts = extract_numeric_parts(b);

    if !a_parts.is_empty() || !b_parts.is_empty() {
        let len = a_parts.len().max(b_parts.len());
        a_parts.resize(len, 0);
        b_parts.resize(len, 0);

        for (a_part, b_part) in a_parts.iter().zip(b_parts.iter()) {
            match a_part.cmp(b_part) {
                Ordering::Equal => continue,
                non_eq => return non_eq,
            }
        }
    }

    a.cmp(b)
}

#[derive(Clone)]
pub struct DataService {
    data_dir: PathBuf,
    index_db_path: PathBuf,
}

impl DataService {
    pub fn is_installed(&self) -> bool {
        self.data_dir
            .join("zh_CN/gamedata/excel/story_review_table.json")
            .exists()
    }
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            data_dir: app_data_dir.join("ArknightsGameData"),
            index_db_path: app_data_dir.join("story_index.db"),
        }
    }

    fn open_index_connection(&self) -> Result<Connection, String> {
        if let Some(parent) = self.index_db_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create index directory: {}", e))?;
        }
        let conn = Connection::open(&self.index_db_path)
            .map_err(|e| format!("Failed to open story index database: {}", e))?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            ",
        )
        .map_err(|e| format!("Failed to configure index database: {}", e))?;
        Ok(conn)
    }

    fn try_open_index_connection(&self) -> Result<Option<Connection>, String> {
        if !self.index_db_path.exists() {
            return Ok(None);
        }
        match self.open_index_connection() {
            Ok(conn) => Ok(Some(conn)),
            Err(err) => {
                eprintln!("[INDEX] Failed to open story index: {}", err);
                Ok(None)
            }
        }
    }

    fn init_index_tables(conn: &Connection) -> Result<(), String> {
        // meta table
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS story_index_meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            ",
        )
        .map_err(|e| format!("Failed to init story index meta: {}", e))?;

        // read current version
        let current_version: i32 = conn
            .query_row(
                "SELECT value FROM story_index_meta WHERE key = 'index_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|s| s.parse::<i32>().ok())
            .unwrap_or(0);

        let should_recreate = current_version < INDEX_VERSION;

        if should_recreate {
            // Drop and recreate virtual table with new schema
            conn.execute_batch(
                "
                DROP TABLE IF EXISTS story_index;
                CREATE VIRTUAL TABLE story_index USING fts5(
                    story_id UNINDEXED,
                    story_name,
                    category UNINDEXED,
                    tokenized_content,
                    story_code,
                    raw_content UNINDEXED,
                    tokenize = 'unicode61 remove_diacritics 2',
                    prefix='2 3 4'
                );
                ",
            )
            .map_err(|e| format!("Failed to (re)create story index: {}", e))?;

            conn.execute(
                "INSERT INTO story_index_meta (key, value) VALUES ('index_version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![INDEX_VERSION.to_string()],
            )
            .map_err(|e| format!("Failed to update index version: {}", e))?;
        } else {
            // Ensure table exists (fresh install)
            conn.execute_batch(
                "
                CREATE VIRTUAL TABLE IF NOT EXISTS story_index USING fts5(
                    story_id UNINDEXED,
                    story_name,
                    category UNINDEXED,
                    tokenized_content,
                    story_code,
                    raw_content UNINDEXED,
                    tokenize = 'unicode61 remove_diacritics 2',
                    prefix='2 3 4'
                );
                ",
            )
            .map_err(|e| format!("Failed to ensure story index table: {}", e))?;
        }

        Ok(())
    }

    fn clear_story_index(&self) -> Result<(), String> {
        if self.index_db_path.exists() {
            fs::remove_file(&self.index_db_path)
                .map_err(|e| format!("Failed to remove story index: {}", e))?;
        }
        Ok(())
    }

    fn entry_type_display(entry_type: &str) -> String {
        match entry_type {
            "MAINLINE" => "主线".to_string(),
            "ACTIVITY" | "MINI_ACTIVITY" => "活动".to_string(),
            "ROGUELIKE" => "肉鸽".to_string(),
            "SIDESTORY" => "支线".to_string(),
            "NONE" => "干员密录".to_string(),
            _ => entry_type.to_string(),
        }
    }

    fn resolve_category_name(entry_type: &str, entry_id: &str, value: &Value) -> String {
        if let Some(name) = value
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return name.to_string();
        }

        let display = Self::entry_type_display(entry_type);
        if display == entry_type {
            format!("{} ({})", entry_type, entry_id)
        } else {
            format!("{} ({})", display, entry_id)
        }
    }

    fn format_category_label(entry_type: &str, category_name: &str) -> String {
        let prefix = Self::entry_type_display(entry_type);
        let name = category_name.trim();
        if name.is_empty() || name == prefix {
            prefix
        } else {
            format!("{} | {}", prefix, name)
        }
    }

    fn collect_stories_for_index(&self) -> Result<Vec<IndexedStory>, String> {
        if !self.is_installed() {
            return Err("NOT_INSTALLED".to_string());
        }

        let story_review_file = self
            .data_dir
            .join("zh_CN/gamedata/excel/story_review_table.json");

        let content = fs::read_to_string(&story_review_file)
            .map_err(|e| format!("Failed to read story review file: {}", e))?;

        let data: HashMap<String, Value> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse story review data: {}", e))?;

        let mut seen_ids = HashSet::new();
        let mut stories = Vec::new();

        for (entry_id, value) in data.iter() {
            let entry_type = value
                .get("entryType")
                .and_then(|v| v.as_str())
                .unwrap_or("UNKNOWN");

            let Some(unlock_datas) = value.get("infoUnlockDatas").and_then(|v| v.as_array()) else {
                continue;
            };

            let category_name = Self::resolve_category_name(entry_type, entry_id, value);

            for unlock_data in unlock_datas {
                if let Ok(story) = serde_json::from_value::<StoryEntry>(unlock_data.clone()) {
                    if story.story_txt.trim().is_empty() {
                        continue;
                    }
                    if seen_ids.insert(story.story_id.clone()) {
                        stories.push(IndexedStory {
                            category_name: category_name.clone(),
                            entry_type: entry_type.to_string(),
                            story,
                        });
                    }
                }
            }
        }

        stories.sort_by(|a, b| a.story.story_id.cmp(&b.story.story_id));
        Ok(stories)
    }

    fn flatten_segments(segments: &[StorySegment]) -> String {
        let mut parts = Vec::with_capacity(segments.len());
        for segment in segments {
            match segment {
                StorySegment::Dialogue {
                    character_name,
                    text,
                    ..
                } => {
                    parts.push(format!("{}：{}", character_name, text));
                }
                StorySegment::Narration { text }
                | StorySegment::System { text, .. }
                | StorySegment::Subtitle { text, .. }
                | StorySegment::Sticker { text, .. } => {
                    parts.push(text.clone());
                }
                StorySegment::Decision { options, .. } => {
                    // Use newline separator so each option is tokenized/indexed
                    // independently — users searching an option verbatim should
                    // still be able to hit the story. (bug A9)
                    parts.push(options.join("\n"));
                }
                StorySegment::Header { title } => {
                    parts.push(title.clone());
                }
            }
        }
        parts.join("\n")
    }

    fn tokenize_for_fts(text: &str) -> Vec<String> {
        let text = normalize_nfkc_lower_strip_marks(text);
        let mut tokens = Vec::new();
        let mut ascii_buffer = String::new();

        for ch in text.chars() {
            if ch.is_ascii_alphanumeric() {
                ascii_buffer.push(ch.to_ascii_lowercase());
                continue;
            }

            if !ascii_buffer.is_empty() {
                let token = std::mem::take(&mut ascii_buffer);
                tokens.push(token);
            }

            if ch.is_whitespace() {
                continue;
            }

            if is_common_punctuation(ch) {
                continue;
            }

            if ch.is_alphanumeric() {
                let token: String = ch.to_lowercase().collect();
                if !token.is_empty() {
                    tokens.push(token);
                }
                continue;
            }

            tokens.push(ch.to_string());
        }

        if !ascii_buffer.is_empty() {
            tokens.push(ascii_buffer);
        }

        tokens
    }

    fn build_tokenized_content(text: &str) -> String {
        Self::tokenize_for_fts(text).join(" ")
    }

    // Build a more expressive FTS query:
    // - Normalize (NFKC + lowercase + strip marks)
    // - Chinese contiguous sequences (len>=2) -> quoted phrase of spaced characters: "凯 尔 希"
    // - ASCII terms -> add * suffix for prefix match
    // - Support simple NOT via leading '-' and OR keyword, default AND
    fn build_fts_query_advanced(raw_query: &str) -> Option<String> {
        let q = normalize_nfkc_lower_strip_marks(raw_query.trim());
        if q.is_empty() {
            return None;
        }

        // Simple tokenizer that respects quoted phrases
        let mut terms: Vec<(String, bool, bool)> = Vec::new(); // (term, is_not, is_or_before)
        let mut buf = String::new();
        let mut in_quotes = false;
        let mut prev_was_or = false;
        let mut chars = q.chars().peekable();
        while let Some(ch) = chars.next() {
            match ch {
                '"' => {
                    if in_quotes {
                        in_quotes = false;
                        let t = std::mem::take(&mut buf);
                        if !t.is_empty() {
                            terms.push((t, false, prev_was_or));
                            prev_was_or = false;
                        }
                    } else {
                        if !buf.trim().is_empty() {
                            let t = std::mem::take(&mut buf);
                            if t == "or" {
                                prev_was_or = true;
                            } else {
                                let is_not = t.starts_with('-');
                                let content = if is_not {
                                    t.trim_start_matches('-').to_string()
                                } else {
                                    t
                                };
                                if !content.is_empty() {
                                    terms.push((content, is_not, prev_was_or));
                                    prev_was_or = false;
                                }
                            }
                        }
                        in_quotes = true;
                    }
                }
                c if c.is_whitespace() && !in_quotes => {
                    if !buf.is_empty() {
                        let t = std::mem::take(&mut buf);
                        if t == "or" {
                            prev_was_or = true;
                        } else {
                            let is_not = t.starts_with('-');
                            let content = if is_not {
                                t.trim_start_matches('-').to_string()
                            } else {
                                t
                            };
                            if !content.is_empty() {
                                terms.push((content, is_not, prev_was_or));
                                prev_was_or = false;
                            }
                        }
                    }
                }
                _ => buf.push(ch),
            }
        }
        if !buf.is_empty() {
            let t = std::mem::take(&mut buf);
            if t == "or" {
                // dangling OR, ignore
            } else {
                let is_not = t.starts_with('-');
                let content = if is_not {
                    t.trim_start_matches('-').to_string()
                } else {
                    t
                };
                if !content.is_empty() {
                    terms.push((content, is_not, prev_was_or));
                }
            }
        }

        if terms.is_empty() {
            return None;
        }

        fn is_fts_special(c: char) -> bool {
            // FTS5 query special characters we must not expose verbatim.
            matches!(c, '"' | '*' | ':' | '(' | ')' | '+' | '-' | '^' | '\\')
        }

        fn sanitize_term(s: &str) -> String {
            // Replace FTS5 specials with spaces; also drop control chars.
            s.chars()
                .map(|c| if is_fts_special(c) || c.is_control() { ' ' } else { c })
                .collect::<String>()
                .trim()
                .to_string()
        }

        fn to_phrase_if_cjk(s: &str) -> String {
            let sanitized = sanitize_term(s);
            if sanitized.is_empty() {
                return String::new();
            }
            let mut has_cjk = false;
            let mut all_cjk = true;
            for ch in sanitized.chars() {
                if is_cjk(ch) {
                    has_cjk = true;
                } else if !ch.is_whitespace() {
                    all_cjk = false;
                }
            }
            if has_cjk && all_cjk {
                let cjk_chars: Vec<char> = sanitized
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect();
                if cjk_chars.is_empty() {
                    return String::new();
                }
                // Short phrase: keep strict ordering.
                if cjk_chars.len() <= 3 {
                    let spaced: String = cjk_chars
                        .iter()
                        .map(|c| c.to_string())
                        .collect::<Vec<_>>()
                        .join(" ");
                    return format!("\"{}\"", spaced);
                }
                // Long phrase (>=4 chars): since tokenized_content stores each
                // CJK char as a single token with spaces, the original strict
                // phrase "凯 尔 希 阿 米 娅" requires the 6 chars to appear
                // strictly consecutive which is brittle. Expand into overlapping
                // bigrams joined by AND — recall goes up without sacrificing
                // precision much. (bug B5/B6, D4)
                let mut pieces: Vec<String> = Vec::new();
                for window in cjk_chars.windows(2) {
                    pieces.push(format!("\"{} {}\"", window[0], window[1]));
                }
                format!("({})", pieces.join(" AND "))
            } else if sanitized.chars().all(|c| c.is_ascii_alphanumeric()) {
                format!("{}*", sanitized)
            } else {
                // Mixed CJK+ASCII/digit — strip FTS specials and emit as spaced phrase.
                let mut spaced = String::new();
                for ch in sanitized.chars() {
                    if ch.is_whitespace() {
                        continue;
                    }
                    if !spaced.is_empty() {
                        spaced.push(' ');
                    }
                    spaced.push(ch);
                }
                if spaced.is_empty() {
                    String::new()
                } else {
                    format!("\"{}\"", spaced)
                }
            }
        }

        let mut parts: Vec<String> = Vec::new();
        for (raw, is_not, is_or) in terms.into_iter() {
            if raw.is_empty() {
                continue;
            }
            let phrase = to_phrase_if_cjk(&raw);
            if phrase.is_empty() {
                // Sanitization removed everything — skip this term entirely
                // and don't emit a dangling connector.
                continue;
            }
            let piece = if is_not { format!("NOT {}", phrase) } else { phrase };
            if !parts.is_empty() {
                parts.push(if is_or { "OR".to_string() } else { "AND".to_string() });
            }
            parts.push(piece);
        }

        if parts.is_empty() {
            None
        } else {
            Some(parts.join(" "))
        }
    }

    fn extract_meta_value(conn: &Connection, key: &str) -> Result<Option<String>, String> {
        conn.query_row(
            "SELECT value FROM story_index_meta WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read story index meta {}: {}", key, e))
    }

    /// 下载并解压最新数据包
    pub fn sync_data(&self, app: AppHandle) -> Result<(), String> {
        eprintln!("[SYNC] === 开始同步数据 ===");
        emit_progress(&app, "准备", 0, 1, "正在初始化同步环境");

        eprintln!("[SYNC] 创建 HTTP 客户端");
        let client = Self::create_http_client()?;

        eprintln!("[SYNC] 获取最新 commit");
        let remote_commit = match self.fetch_latest_commit(&client) {
            Ok(commit) => {
                eprintln!("[SYNC] 成功获取 commit: {}", &commit);
                let short = commit.get(..7).unwrap_or(commit.as_str());
                emit_progress(&app, "准备", 1, 1, format!("最新版本 {}", short));
                Some(commit)
            }
            Err(err) => {
                eprintln!("[SYNC] 获取 commit 失败: {}", err);
                emit_progress(
                    &app,
                    "准备",
                    0,
                    1,
                    format!("获取版本信息失败，回退到 {}: {}", DEFAULT_BRANCH, err),
                );
                None
            }
        };

        let reference = remote_commit
            .clone()
            .unwrap_or_else(|| DEFAULT_BRANCH.to_string());
        eprintln!("[SYNC] 使用引用: {}", reference);

        eprintln!("[SYNC] 开始下载和解压");
        self.download_and_extract(&client, &app, &reference)?;
        eprintln!("[SYNC] 下载和解压完成");

        if let Err(err) = self.clear_story_index() {
            eprintln!("[SYNC] Failed to reset story index: {}", err);
        }

        // 写入版本信息
        eprintln!("[SYNC] 写入版本信息");
        let commit_to_store = remote_commit.unwrap_or_else(|| "unknown".to_string());
        let fetched_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let info = VersionInfo {
            commit: commit_to_store,
            fetched_at,
        };
        self.write_version(&info)?;

        // Auto-rebuild the FTS index so the next search is immediately fast
        // instead of silently falling back to linear scan (bug A5).
        emit_progress(&app, "索引", 0, 1, "正在重建全文索引");
        let index_service = self.clone();
        let index_app = app.clone();
        std::thread::spawn(move || {
            if let Err(err) = index_service.rebuild_story_index_with_progress(&index_app) {
                eprintln!("[SYNC] auto rebuild index failed: {}", err);
                emit_progress(&index_app, "索引", 1, 1, "索引重建失败，可稍后在设置中手动重试");
            } else {
                emit_progress(&index_app, "索引", 1, 1, "全文索引已重建");
            }
        });

        eprintln!("[SYNC] === 同步完成 ===");
        emit_progress(&app, "完成", 1, 1, "同步完成");
        Ok(())
    }

    pub fn get_current_version(&self) -> Result<String, String> {
        if let Some(info) = self.read_version() {
            let commit_short = if info.commit.len() >= 7 {
                &info.commit[..7]
            } else {
                info.commit.as_str()
            };
            Ok(format!(
                "{} ({})",
                commit_short,
                format_timestamp(info.fetched_at)
            ))
        } else {
            Ok("未安装".to_string())
        }
    }

    pub fn get_remote_version(&self) -> Result<String, String> {
        let client = Self::create_http_client()?;
        match self.fetch_latest_commit(&client) {
            Ok(commit) => {
                let short = if commit.len() >= 7 {
                    &commit[..7]
                } else {
                    commit.as_str()
                };
                Ok(short.to_string())
            }
            Err(_) => Ok("未知".to_string()),
        }
    }

    pub fn check_update(&self) -> Result<bool, String> {
        let current = self.read_version();
        if current.is_none() {
            return Ok(true);
        }

        let client = Self::create_http_client()?;
        match self.fetch_latest_commit(&client) {
            Ok(remote) => {
                if let Some(cur) = current {
                    Ok(cur.commit != remote)
                } else {
                    Ok(true)
                }
            }
            Err(_) => Ok(true),
        }
    }

    fn create_http_client() -> Result<Client, String> {
        Client::builder()
            .user_agent("arknights-story-reader")
            .build()
            .map_err(|e| format!("Failed to create http client: {}", e))
    }

    fn fetch_latest_commit(&self, client: &Client) -> Result<String, String> {
        let url = format!("{}/commits/{}", REPO_API_URL, DEFAULT_BRANCH);
        let response = client
            .get(&url)
            .send()
            .map_err(|e| format!("Failed to request latest commit: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("GitHub API returned status {}", response.status()));
        }

        let value: serde_json::Value = response
            .json()
            .map_err(|e| format!("Failed to parse commit response: {}", e))?;

        value
            .get("sha")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "Failed to read commit sha".to_string())
    }

    fn download_and_extract(
        &self,
        client: &Client,
        app: &AppHandle,
        reference: &str,
    ) -> Result<(), String> {
        eprintln!("[SYNC] download_and_extract 开始");
        let parent_dir = self
            .data_dir
            .parent()
            .ok_or_else(|| "Invalid data directory".to_string())?;
        eprintln!("[SYNC] parent_dir: {:?}", parent_dir);

        let download_url = format!("{}/{}", REPO_DOWNLOAD_URL, reference);
        eprintln!("[SYNC] download_url: {}", download_url);
        emit_progress(app, "下载", 0, 100, format!("从 {} 下载", reference));

        eprintln!("[SYNC] 发起 HTTP GET 请求");
        let mut response = client.get(&download_url).send().map_err(|e| {
            eprintln!("[SYNC ERROR] HTTP 请求失败: {}", e);
            format!("Download failed: {}", e)
        })?;

        eprintln!("[SYNC] HTTP 状态码: {}", response.status());
        if !response.status().is_success() {
            return Err(format!("Download returned status {}", response.status()));
        }

        let total_bytes = response.content_length().unwrap_or(0) as usize;
        let zip_path = parent_dir.join("ArknightsGameData.zip");
        let mut zip_file = fs::File::create(&zip_path)
            .map_err(|e| format!("Failed to create temp zip file: {}", e))?;

        let mut downloaded: usize = 0;
        let mut buffer = [0u8; 8192];
        loop {
            let bytes_read = response
                .read(&mut buffer)
                .map_err(|e| format!("Failed to read download stream: {}", e))?;
            if bytes_read == 0 {
                break;
            }
            zip_file
                .write_all(&buffer[..bytes_read])
                .map_err(|e| format!("Failed to write zip data: {}", e))?;
            downloaded += bytes_read;

            let percent = if total_bytes > 0 {
                (downloaded as f64 / total_bytes as f64 * 100.0).min(100.0)
            } else {
                0.0
            };
            let downloaded_mb = downloaded as f64 / 1_048_576.0;
            let total_mb = total_bytes as f64 / 1_048_576.0;
            let message = if total_bytes > 0 {
                format!("已下载 {:.1}/{:.1} MB", downloaded_mb, total_mb.max(0.1))
            } else {
                format!("已下载 {:.1} MB", downloaded_mb)
            };
            emit_progress(app, "下载", percent.round() as usize, 100, message);
        }
        zip_file
            .flush()
            .map_err(|e| format!("Failed to flush zip file: {}", e))?;

        emit_progress(app, "下载", 100, 100, "下载完成");
        self.extract_zip_at(&zip_path, parent_dir, app)?;
        fs::remove_file(&zip_path).ok();

        Ok(())
    }

    fn extract_zip_at(
        &self,
        zip_path: &Path,
        parent_dir: &Path,
        app: &AppHandle,
    ) -> Result<(), String> {
        emit_progress(app, "解压", 0, 100, "正在解压数据");
        let extract_root = parent_dir.join("ArknightsGameData_extract");
        if extract_root.exists() {
            fs::remove_dir_all(&extract_root)
                .map_err(|e| format!("Failed to clean extract dir: {}", e))?;
        }
        fs::create_dir_all(&extract_root)
            .map_err(|e| format!("Failed to create extract dir: {}", e))?;

        let zip_file = fs::File::open(zip_path)
            .map_err(|e| format!("Failed to open downloaded zip: {}", e))?;
        let mut archive =
            ZipArchive::new(zip_file).map_err(|e| format!("Failed to read zip archive: {}", e))?;

        let total_entries = usize::max(archive.len(), 1);
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| format!("Failed to access zip entry: {}", e))?;
            let relative_path = match file.enclosed_name() {
                Some(path) => path.to_owned(),
                None => continue,
            };
            let out_path = extract_root.join(&relative_path);

            if file.is_dir() {
                fs::create_dir_all(&out_path)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            } else {
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create parent directory: {}", e))?;
                }
                let mut outfile = fs::File::create(&out_path)
                    .map_err(|e| format!("Failed to create file: {}", e))?;
                std::io::copy(&mut file, &mut outfile)
                    .map_err(|e| format!("Failed to write file: {}", e))?;
            }

            let percent = ((i + 1) as f64 / total_entries as f64 * 100.0).min(100.0);
            emit_progress(
                app,
                "解压",
                percent.round() as usize,
                100,
                format!("解压 {}/{} ({:.1}%)", i + 1, total_entries, percent),
            );
        }

        emit_progress(app, "解压", 100, 100, "解压完成");

        let extracted_root = fs::read_dir(&extract_root)
            .map_err(|e| format!("Failed to read extracted directory: {}", e))?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|path| path.is_dir())
            .ok_or_else(|| "解压后的文件结构不正确".to_string())?;

        if self.data_dir.exists() {
            fs::remove_dir_all(&self.data_dir)
                .map_err(|e| format!("Failed to remove old data: {}", e))?;
        }

        match fs::rename(&extracted_root, &self.data_dir) {
            Ok(_) => {}
            Err(_) => {
                copy_dir_all(&extracted_root, &self.data_dir)?;
                fs::remove_dir_all(&extracted_root).ok();
            }
        }

        fs::remove_dir_all(&extract_root).ok();
        Ok(())
    }

    fn finalize_manual_import(&self, temp_path: &Path, app: &AppHandle) -> Result<(), String> {
        let parent_dir = self
            .data_dir
            .parent()
            .ok_or_else(|| "Invalid data directory".to_string())?;

        emit_progress(app, "导入", 40, 100, "正在解压 ZIP 文件");
        self.extract_zip_at(temp_path, parent_dir, app)?;
        fs::remove_file(temp_path).ok();

        if let Err(err) = self.clear_story_index() {
            eprintln!("[IMPORT] Failed to reset story index: {}", err);
        }

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let info = VersionInfo {
            commit: format!("manual-{}", timestamp),
            fetched_at: timestamp,
        };
        self.write_version(&info)?;

        // Auto-rebuild the FTS index (bug A5, same as sync_data).
        emit_progress(app, "索引", 0, 1, "正在重建全文索引");
        let index_service = self.clone();
        let index_app = app.clone();
        std::thread::spawn(move || {
            if let Err(err) = index_service.rebuild_story_index_with_progress(&index_app) {
                eprintln!("[IMPORT] auto rebuild index failed: {}", err);
                emit_progress(&index_app, "索引", 1, 1, "索引重建失败，可稍后在设置中手动重试");
            } else {
                emit_progress(&index_app, "索引", 1, 1, "全文索引已重建");
            }
        });

        emit_progress(app, "完成", 100, 100, "导入完成");
        Ok(())
    }

    pub fn import_zip_from_path<P: AsRef<Path>>(
        &self,
        source: P,
        app: AppHandle,
    ) -> Result<(), String> {
        let source_path = source.as_ref();
        if !source_path.exists() {
            return Err("ZIP 文件不存在".to_string());
        }

        let parent_dir = self
            .data_dir
            .parent()
            .ok_or_else(|| "Invalid data directory".to_string())?;

        let temp_path = parent_dir.join("ArknightsGameData_import.zip");
        emit_progress(&app, "导入", 0, 100, "正在复制 ZIP 文件");
        fs::copy(source_path, &temp_path).map_err(|e| format!("复制 ZIP 文件失败: {}", e))?;

        emit_progress(&app, "导入", 30, 100, "正在校验 ZIP 文件");
        self.finalize_manual_import(&temp_path, &app)
    }

    pub fn import_zip_from_bytes(&self, data: &[u8], app: AppHandle) -> Result<(), String> {
        let parent_dir = self
            .data_dir
            .parent()
            .ok_or_else(|| "Invalid data directory".to_string())?;

        fs::create_dir_all(parent_dir).map_err(|e| format!("无法创建数据目录: {}", e))?;

        let temp_path = parent_dir.join("ArknightsGameData_import.zip");
        emit_progress(&app, "导入", 0, 100, "正在写入 ZIP 数据");
        fs::write(&temp_path, data).map_err(|e| format!("写入 ZIP 数据失败: {}", e))?;

        emit_progress(&app, "导入", 30, 100, "正在校验 ZIP 文件");
        self.finalize_manual_import(&temp_path, &app)
    }

    fn version_file_path(&self) -> PathBuf {
        self.data_dir.join(VERSION_FILE)
    }

    fn read_version(&self) -> Option<VersionInfo> {
        let path = self.version_file_path();
        if !path.exists() {
            return None;
        }
        let content = fs::read_to_string(&path).ok()?;
        serde_json::from_str(&content).ok()
    }

    fn write_version(&self, info: &VersionInfo) -> Result<(), String> {
        if !self.data_dir.exists() {
            fs::create_dir_all(&self.data_dir)
                .map_err(|e| format!("Failed to create data directory: {}", e))?;
        }
        let path = self.version_file_path();
        let content = serde_json::to_string_pretty(info)
            .map_err(|e| format!("Failed to serialize version info: {}", e))?;
        fs::write(&path, content).map_err(|e| format!("Failed to write version info: {}", e))
    }
}

/// 格式化时间戳
fn format_timestamp(timestamp: i64) -> String {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    let duration = Duration::from_secs(timestamp as u64);
    let datetime = UNIX_EPOCH + duration;

    if let Ok(elapsed) = SystemTime::now().duration_since(datetime) {
        let days = elapsed.as_secs() / 86400;
        if days == 0 {
            let hours = elapsed.as_secs() / 3600;
            if hours == 0 {
                let mins = elapsed.as_secs() / 60;
                return format!("{}分钟前", mins.max(1));
            }
            return format!("{}小时前", hours);
        } else if days < 30 {
            return format!("{}天前", days);
        }
    }

    "较早前".to_string()
}

impl DataService {
    /// 获取所有章节
    pub fn get_chapters(&self) -> Result<Vec<Chapter>, String> {
        if !self.is_installed() {
            return Err("NOT_INSTALLED".to_string());
        }
        let chapter_file = self
            .data_dir
            .join("zh_CN/gamedata/excel/chapter_table.json");

        let content = fs::read_to_string(&chapter_file)
            .map_err(|e| format!("Failed to read chapter file: {}", e))?;

        let data: HashMap<String, Chapter> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse chapter data: {}", e))?;

        let mut chapters: Vec<Chapter> = data.into_values().collect();
        chapters.sort_by_key(|c| c.chapter_index);

        Ok(chapters)
    }

    /// 获取所有活动
    pub fn get_activities(&self) -> Result<Vec<Activity>, String> {
        if !self.is_installed() {
            return Err("NOT_INSTALLED".to_string());
        }
        let story_review_file = self
            .data_dir
            .join("zh_CN/gamedata/excel/story_review_table.json");

        let content = fs::read_to_string(&story_review_file)
            .map_err(|e| format!("Failed to read story review file: {}", e))?;

        let data: HashMap<String, Value> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse story review data: {}", e))?;

        let mut activities = Vec::new();

        for (id, value) in data.iter() {
            if let Some(entry_type) = value.get("entryType").and_then(|v| v.as_str()) {
                if entry_type == "ACTIVITY" {
                    let activity: Activity = serde_json::from_value(value.clone())
                        .map_err(|e| format!("Failed to parse activity: {}", e))?;
                    activities.push(Activity {
                        id: id.clone(),
                        ..activity
                    });
                }
            }
        }

        Ok(activities)
    }

    /// 获取分类的剧情列表（仅返回分类，不含故事列表）
    pub fn get_story_categories(&self) -> Result<Vec<StoryCategory>, String> {
        if !self.is_installed() {
            return Err("NOT_INSTALLED".to_string());
        }

        let story_review_file = self
            .data_dir
            .join("zh_CN/gamedata/excel/story_review_table.json");

        let content = fs::read_to_string(&story_review_file)
            .map_err(|e| format!("Failed to read story review file: {}", e))?;

        let data: HashMap<String, Value> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse story review data: {}", e))?;

        let mut categories = Vec::new();

        // 主线剧情
        let main_stories = self.parse_stories_by_entry_type(&data, "MAINLINE")?;
        if !main_stories.is_empty() {
            categories.push(StoryCategory {
                id: "mainline".to_string(),
                name: "主线剧情".to_string(),
                category_type: "chapter".to_string(),
                stories: main_stories,
            });
        }

        Ok(categories)
    }

    /// 根据 entryType 解析剧情
    fn parse_stories_by_entry_type(
        &self,
        data: &HashMap<String, Value>,
        entry_type: &str,
    ) -> Result<Vec<StoryEntry>, String> {
        let mut stories = Vec::new();

        for (_id, value) in data.iter() {
            if let Some(et) = value.get("entryType").and_then(|v| v.as_str()) {
                if et == entry_type {
                    if let Some(unlock_datas) =
                        value.get("infoUnlockDatas").and_then(|v| v.as_array())
                    {
                        for unlock_data in unlock_datas {
                            if let Ok(story) =
                                serde_json::from_value::<StoryEntry>(unlock_data.clone())
                            {
                                stories.push(story);
                            }
                        }
                    }
                }
            }
        }

        stories.sort_by_key(|s| s.story_sort);
        Ok(stories)
    }

    /// 获取主线剧情
    fn get_main_stories(&self) -> Result<Vec<StoryEntry>, String> {
        let story_review_file = self
            .data_dir
            .join("zh_CN/gamedata/excel/story_review_table.json");

        let content = fs::read_to_string(&story_review_file)
            .map_err(|e| format!("Failed to read story review file: {}", e))?;

        let data: HashMap<String, Value> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse story review data: {}", e))?;

        let mut stories = Vec::new();

        for (_id, value) in data.iter() {
            if let Some(entry_type) = value.get("entryType").and_then(|v| v.as_str()) {
                if entry_type == "MAINLINE" {
                    if let Some(unlock_datas) =
                        value.get("infoUnlockDatas").and_then(|v| v.as_array())
                    {
                        for unlock_data in unlock_datas {
                            if let Ok(story) =
                                serde_json::from_value::<StoryEntry>(unlock_data.clone())
                            {
                                stories.push(story);
                            }
                        }
                    }
                }
            }
        }

        stories.sort_by_key(|s| s.story_sort);
        Ok(stories)
    }

    /// 读取剧情文本
    pub fn read_story_text(&self, story_path: &str) -> Result<String, String> {
        let full_path = self
            .data_dir
            .join("zh_CN/gamedata/story")
            .join(format!("{}.txt", story_path));

        fs::read_to_string(&full_path).map_err(|e| format!("Failed to read story file: {}", e))
    }

    /// 读取剧情简介
    pub fn read_story_info(&self, info_path: &str) -> Result<String, String> {
        let base_dir = self.data_dir.join("zh_CN/gamedata/story");

        let trimmed = info_path.trim();
        if trimmed.is_empty() {
            return Err("Failed to read info file: empty info path".to_string());
        }

        let normalized = trimmed
            .trim_matches(|c| c == '/' || c == '\\')
            .replace('\\', "/");

        let mut candidates = Vec::new();
        candidates.push(base_dir.join(format!("{}.txt", normalized)));

        if normalized.starts_with("info/") {
            let replaced = normalized.replacen("info/", "[uc]info/", 1);
            candidates.push(base_dir.join(format!("{}.txt", replaced)));
        }

        for candidate in &candidates {
            match fs::read_to_string(candidate) {
                Ok(content) => return Ok(content),
                Err(err) if err.kind() == ErrorKind::NotFound => continue,
                Err(err) => {
                    return Err(format!("Failed to read info file: {}", err));
                }
            }
        }

        Err(format!(
            "Failed to read info file: {} (candidates: {})",
            info_path,
            candidates
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }

    /// 重建剧情全文索引
    pub fn rebuild_story_index(&self) -> Result<(), String> {
        self.rebuild_story_index_inner(None)
    }

    /// 重建索引并发出 `index-progress` 事件
    pub fn rebuild_story_index_with_progress(&self, app: &AppHandle) -> Result<(), String> {
        self.rebuild_story_index_inner(Some(app))
    }

    fn rebuild_story_index_inner(&self, app: Option<&AppHandle>) -> Result<(), String> {
        if !self.is_installed() {
            return Err("NOT_INSTALLED".to_string());
        }

        let emit = |phase: &str, cur: usize, total: usize, msg: &str| {
            if let Some(app) = app {
                let progress = IndexProgress {
                    phase: phase.to_string(),
                    current: cur,
                    total,
                    message: msg.to_string(),
                };
                let _ = app.emit("index-progress", progress);
            }
        };

        let mut conn = self.open_index_connection()?;
        Self::init_index_tables(&conn)?;

        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start index transaction: {}", e))?;

        tx.execute("DELETE FROM story_index", [])
            .map_err(|e| format!("Failed to clear story index: {}", e))?;

        let indexed_stories = self.collect_stories_for_index()?;
        let mut insert_stmt = tx
            .prepare(
                "
            INSERT INTO story_index (
                story_id,
                story_name,
                category,
                tokenized_content,
                story_code,
                raw_content
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ",
            )
            .map_err(|e| format!("Failed to prepare story index insert: {}", e))?;

        let mut total = 0usize;

        emit("收集", 0, indexed_stories.len(), "加载剧情清单");

        for (idx, indexed) in indexed_stories.iter().enumerate() {
            let story_id = &indexed.story.story_id;
            let story_name = &indexed.story.story_name;
            let story_path = &indexed.story.story_txt;

            let raw_text = match self.read_story_text(story_path) {
                Ok(text) => text,
                Err(err) => {
                    eprintln!(
                        "[INDEX] Skip story {}: failed to read text ({})",
                        story_id, err
                    );
                    continue;
                }
            };

            let parsed = parse_story_text(&raw_text);
            let flattened = Self::flatten_segments(&parsed.segments);

            let combined_raw = if flattened.trim().is_empty() {
                story_name.clone()
            } else {
                format!("{}\n{}", story_name, flattened)
            };

            let tokenized = Self::build_tokenized_content(&combined_raw);
            if tokenized.trim().is_empty() {
                continue;
            }

            let category_label =
                Self::format_category_label(&indexed.entry_type, &indexed.category_name);

            insert_stmt
                .execute(params![
                    story_id,
                    story_name,
                    &category_label,
                    tokenized,
                    indexed
                        .story
                        .story_code
                        .as_ref()
                        .map(|s| normalize_nfkc_lower_strip_marks(s))
                        .unwrap_or_default(),
                    combined_raw
                ])
                .map_err(|e| format!("Failed to insert story into index: {}", e))?;
            total += 1;

            // Batch progress events to avoid flooding the frontend bus.
            if (idx + 1) % 16 == 0 || idx + 1 == indexed_stories.len() {
                emit(
                    "构建",
                    idx + 1,
                    indexed_stories.len(),
                    story_name,
                );
            }
        }

        drop(insert_stmt);

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        tx.execute(
            "
            INSERT INTO story_index_meta (key, value)
            VALUES ('last_built_at', ?1)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        ",
            params![timestamp.to_string()],
        )
        .map_err(|e| format!("Failed to update index metadata: {}", e))?;

        tx.execute(
            "
            INSERT INTO story_index_meta (key, value)
            VALUES ('total_count', ?1)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        ",
            params![total.to_string()],
        )
        .map_err(|e| format!("Failed to update index total: {}", e))?;

        tx.commit()
            .map_err(|e| format!("Failed to commit story index rebuild: {}", e))?;

        emit("完成", total, total, "索引构建完成");

        Ok(())
    }

    /// 获取索引状态
    pub fn get_story_index_status(&self) -> Result<StoryIndexStatus, String> {
        let Some(conn) = self.try_open_index_connection()? else {
            return Ok(StoryIndexStatus {
                ready: false,
                total: 0,
                last_built_at: None,
            });
        };

        Self::init_index_tables(&conn)?;

        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM story_index", [], |row| row.get(0))
            .unwrap_or(0);

        let last_built_at = Self::extract_meta_value(&conn, "last_built_at")?
            .and_then(|value| value.parse::<i64>().ok());

        Ok(StoryIndexStatus {
            ready: total > 0,
            total: total.max(0) as usize,
            last_built_at,
        })
    }

    fn search_stories_with_index(&self, query: &str) -> Result<Option<Vec<SearchResult>>, String> {
        let Some(conn) = self.try_open_index_connection()? else {
            return Ok(None);
        };

        Self::init_index_tables(&conn)?;

        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM story_index", [], |row| row.get(0))
            .unwrap_or(0);
        if total == 0 {
            return Ok(None);
        }

        let Some(fts_query) = Self::build_fts_query_advanced(query) else {
            return Ok(Some(Vec::new()));
        };

        // bm25() column weights: `story_id`(UNINDEXED)=0, `story_name`=10,
        // `category`(UNINDEXED)=0, `tokenized_content`=1, `story_code`=5,
        // `raw_content`(UNINDEXED)=0. Higher = more relevant. (bug C1)
        let query_sql = format!(
            "
            SELECT story_id, story_name, category, raw_content,
                   snippet(story_index, 3, '', '', '...', 24) as snip
            FROM story_index
            WHERE story_index MATCH ?1
            ORDER BY bm25(story_index, 0.0, 10.0, 0.0, 1.0, 5.0, 0.0)
            LIMIT {}
        ",
            SEARCH_RESULT_LIMIT
        );

        let mut stmt = match conn.prepare(&query_sql) {
            Ok(stmt) => stmt,
            Err(err) => {
                eprintln!("[INDEX] prepare failed: {}", err);
                return Ok(None);
            }
        };

        let rows = match stmt.query_map(params![fts_query], |row| {
            let story_id: String = row.get(0)?;
            let story_name: String = row.get(1)?;
            let category: String = row.get(2)?;
            let raw_content: String = row.get(3)?;
            let snip: String = row.get(4).unwrap_or_else(|_| String::new());
            Ok((story_id, story_name, category, raw_content, snip))
        }) {
            Ok(rows) => rows,
            Err(err) => {
                // FTS5 syntax errors surface here — surface gracefully rather
                // than propagating to frontend (bug B1).
                eprintln!(
                    "[INDEX] execute failed for query '{}' → '{}': {}",
                    query, fts_query, err
                );
                return Ok(None);
            }
        };

        // Fuzzy-normalized query for context extraction.
        let context_probe = normalize_for_fuzzy(query);
        let mut results = Vec::new();
        for row in rows {
            if let Ok((story_id, story_name, category, raw_content, snip)) = row {
                // 优先使用原始内容提取上下文，避免 tokenized_content 导致的空格断字
                let mut matched_text = self.extract_context(&raw_content, &context_probe);
                if matched_text.trim().is_empty() && !snip.trim().is_empty() {
                    // 兜底：少数情况下 extract_context 未命中，回退 snippet 再做一次去空格优化
                    let cleaned = snip
                        .replace('\n', " ")
                        .replace('\r', " ")
                        .replace("  ", " ");
                    matched_text = cleaned;
                }
                if matched_text.is_empty() {
                    let preview: String = raw_content.chars().take(120).collect();
                    matched_text = if preview.len() < raw_content.len() {
                        format!("{}...", preview)
                    } else {
                        preview
                    };
                }
                results.push(SearchResult {
                    story_id,
                    story_name,
                    matched_text,
                    category,
                });
            }
        }

        Ok(Some(results))
    }

    fn search_stories_fallback(&self, query: &str) -> Result<Vec<SearchResult>, String> {
        let mut results = Vec::new();
        let terms = split_query_terms(query);
        if terms.is_empty() {
            return Ok(results);
        }
        // Primary term for context extraction + raw query for display fallback.
        let primary_term = terms[0].clone();

        let stories = self.collect_stories_for_index()?;

        for indexed in &stories {
            let story = &indexed.story;
            let category_label =
                Self::format_category_label(&indexed.entry_type, &indexed.category_name);

            let story_name_norm = normalize_for_fuzzy(&story.story_name);
            let code_norm = story
                .story_code
                .as_ref()
                .map(|s| normalize_for_fuzzy(s))
                .unwrap_or_default();

            // Fast path: title/code AND-hit.
            let title_hits = terms
                .iter()
                .all(|t| story_name_norm.contains(t) || (!code_norm.is_empty() && code_norm.contains(t)));
            if title_hits {
                results.push(SearchResult {
                    story_id: story.story_id.clone(),
                    story_name: story.story_name.clone(),
                    matched_text: story.story_name.clone(),
                    category: category_label,
                });
                if results.len() >= SEARCH_RESULT_LIMIT {
                    return Ok(results);
                }
                continue;
            }

            if let Ok(content) = self.read_story_text(&story.story_txt) {
                // Normalize the content with the same rules used for terms so that
                // `{@nickname}` → `博士`, whitespace and punctuation differences are neutralized.
                let content_norm = normalize_for_fuzzy(&content);
                let body_hits = terms.iter().all(|t| content_norm.contains(t));
                if body_hits {
                    let matched_text = self.extract_context(&content, &primary_term);
                    results.push(SearchResult {
                        story_id: story.story_id.clone(),
                        story_name: story.story_name.clone(),
                        matched_text,
                        category: category_label,
                    });
                    if results.len() >= SEARCH_RESULT_LIMIT {
                        return Ok(results);
                    }
                }
            }
        }

        Ok(results)
    }

    /// 搜索剧情（混合：索引优先 + 线性扫描补全，防止遗漏）
    pub fn search_stories(&self, query: &str) -> Result<Vec<SearchResult>, String> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        // 先走索引
        let mut combined: Vec<SearchResult> = match self.search_stories_with_index(trimmed) {
            Ok(Some(results)) => results,
            Ok(None) => Vec::new(),
            Err(err) => {
                eprintln!(
                    "[INDEX] Failed to search using index ({}), fallback to linear scan",
                    err
                );
                Vec::new()
            }
        };

        // 线性扫描补全（去重 by story_id）
        let mut seen = std::collections::HashSet::new();
        for r in &combined {
            seen.insert(r.story_id.clone());
        }

        let fallback_results = self.search_stories_fallback(trimmed)?;
        for r in fallback_results {
            if seen.insert(r.story_id.clone()) {
                combined.push(r);
                if combined.len() >= SEARCH_RESULT_LIMIT {
                    break;
                }
            }
        }

        Ok(combined)
    }

    /// Extended search: returns total match count (before truncation) and per-
    /// category facet counts so the frontend can offer filter chips and a
    /// "N 条已显示 / M 条匹配" hint. The underlying logic mirrors
    /// `search_stories` (FTS + linear scan, deduped), but it also runs a
    /// separate `COUNT(*)` on the FTS side for accurate totals.
    pub fn search_stories_ex(&self, query: &str) -> Result<SearchResultsPage, String> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(SearchResultsPage {
                results: Vec::new(),
                total_matched: 0,
                truncated: false,
                facets: Default::default(),
            });
        }

        let results = self.search_stories(trimmed)?;

        // Compute total via FTS (best effort — if the index is unavailable we
        // fall back to `results.len()` which is at least a lower bound).
        let total_matched = self
            .count_fts_matches(trimmed)
            .unwrap_or_else(|_| results.len());
        let total_matched = total_matched.max(results.len());

        // Build facets from the returned subset — the frontend can still
        // filter the visible results correctly, and that's the most useful
        // signal. If we wanted exact per-category totals we'd need to issue
        // an aggregated SQL query, but the common case is "results < 500" so
        // per-result counting is accurate in practice.
        let mut facets: std::collections::BTreeMap<String, usize> = Default::default();
        for r in &results {
            *facets.entry(r.category.clone()).or_insert(0) += 1;
        }

        Ok(SearchResultsPage {
            results,
            total_matched,
            truncated: total_matched > SEARCH_RESULT_LIMIT,
            facets,
        })
    }

    fn count_fts_matches(&self, query: &str) -> Result<usize, String> {
        let Some(conn) = self.try_open_index_connection()? else {
            return Ok(0);
        };
        let Some(fts_query) = Self::build_fts_query_advanced(query) else {
            return Ok(0);
        };
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM story_index WHERE story_index MATCH ?1",
                params![fts_query],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(total.max(0) as usize)
    }

    pub fn search_stories_with_debug(&self, query: &str) -> Result<SearchDebugResponse, String> {
        let mut logs = Vec::new();
        let trimmed = query.trim();
        if trimmed.is_empty() {
            logs.push("查询为空，直接返回".to_string());
            return Ok(SearchDebugResponse {
                results: Vec::new(),
                logs,
            });
        }

        let start_time = Instant::now();
        logs.push(format!("开始搜索: \"{}\"", trimmed));

        // Show normalized and FTS query preview
        let normalized = normalize_nfkc_lower_strip_marks(trimmed);
        logs.push(format!("规范化后的查询: \"{}\"", normalized));
        if let Some(fts_query_preview) = Self::build_fts_query_advanced(trimmed) {
            logs.push(format!("FTS 查询: {}", fts_query_preview));
        } else {
            logs.push("FTS 查询为空（可能仅包含标点或无效字符）".to_string());
        }

        let index_attempt_start = Instant::now();
        let mut index_results: Vec<SearchResult> = Vec::new();
        match self.search_stories_with_index(trimmed) {
            Ok(Some(results)) => {
                let index_elapsed = index_attempt_start.elapsed();
                logs.push(format!(
                    "全文索引查询完成，耗时 {} ms，结果 {} 条",
                    index_elapsed.as_millis(),
                    results.len()
                ));
                index_results = results;
            }
            Ok(None) => {
                logs.push(format!(
                    "全文索引不可用或未建立，耗时 {} ms",
                    index_attempt_start.elapsed().as_millis()
                ));
            }
            Err(err) => {
                logs.push(format!(
                    "全文索引查询失败: {} (耗时 {} ms)，将回退线性扫描",
                    err,
                    index_attempt_start.elapsed().as_millis()
                ));
            }
        }

        let fallback_start = Instant::now();
        let fallback_results = self.search_stories_fallback(trimmed)?;
        logs.push(format!(
            "线性扫描完成，耗时 {} ms，结果 {} 条",
            fallback_start.elapsed().as_millis(),
            fallback_results.len()
        ));
        if fallback_results.len() >= SEARCH_RESULT_LIMIT {
            logs.push(format!(
                "结果数量达到上限 {} 条，建议缩小检索范围",
                SEARCH_RESULT_LIMIT
            ));
        }
        // 合并结果（索引优先顺序），去重并截断
        let mut seen = std::collections::HashSet::new();
        let mut merged = Vec::new();
        for r in index_results {
            if seen.insert(r.story_id.clone()) {
                merged.push(r);
                if merged.len() >= SEARCH_RESULT_LIMIT {
                    break;
                }
            }
        }
        let mut added = 0usize;
        if merged.len() < SEARCH_RESULT_LIMIT {
            for r in fallback_results {
                if seen.insert(r.story_id.clone()) {
                    merged.push(r);
                    added += 1;
                    if merged.len() >= SEARCH_RESULT_LIMIT {
                        break;
                    }
                }
            }
        }
        if added > 0 {
            logs.push(format!("线性扫描补全 {} 条结果", added));
        }
        logs.push(format!(
            "搜索总耗时 {} ms",
            start_time.elapsed().as_millis()
        ));

        Ok(SearchDebugResponse {
            results: merged,
            logs,
        })
    }

    /// 带进度事件的搜索：优先使用索引；当回退线性扫描时，实时发送遍历进度
    pub fn search_stories_with_progress(
        &self,
        app: &AppHandle,
        query: &str,
    ) -> Result<Vec<SearchResult>, String> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            emit_search_progress(app, "完成", 1, 1, "查询为空");
            return Ok(Vec::new());
        }

        // 尝试索引
        match self.search_stories_with_index(trimmed) {
            Ok(Some(results)) => {
                emit_search_progress(app, "索引检索", 1, 1, "使用全文索引完成");
                return Ok(results);
            }
            Ok(None) => {
                // fallthrough
            }
            Err(_err) => {
                // fallthrough to fallback scan
            }
        }

        // 线性扫描，实时进度
        let stories = self.collect_stories_for_index()?;
        let total = stories.len();
        emit_search_progress(app, "线性扫描", 0, total.max(1), "开始遍历");

        let mut results = Vec::new();
        let terms = split_query_terms(trimmed);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let primary_term = terms[0].clone();
        for (idx, indexed) in stories.iter().enumerate() {
            let story = &indexed.story;
            let category_label =
                Self::format_category_label(&indexed.entry_type, &indexed.category_name);

            let story_name_norm = normalize_for_fuzzy(&story.story_name);
            let code_norm = story
                .story_code
                .as_ref()
                .map(|s| normalize_for_fuzzy(s))
                .unwrap_or_default();
            let title_hits = terms
                .iter()
                .all(|t| story_name_norm.contains(t) || (!code_norm.is_empty() && code_norm.contains(t)));
            if title_hits {
                results.push(SearchResult {
                    story_id: story.story_id.clone(),
                    story_name: story.story_name.clone(),
                    matched_text: story.story_name.clone(),
                    category: category_label.clone(),
                });
            } else if let Ok(content) = self.read_story_text(&story.story_txt) {
                let content_norm = normalize_for_fuzzy(&content);
                if terms.iter().all(|t| content_norm.contains(t)) {
                    let matched_text = self.extract_context(&content, &primary_term);
                    results.push(SearchResult {
                        story_id: story.story_id.clone(),
                        story_name: story.story_name.clone(),
                        matched_text,
                        category: category_label.clone(),
                    });
                }
            }

            emit_search_progress(
                app,
                "线性扫描",
                (idx + 1).min(total),
                total.max(1),
                format!("已扫描 {} / {}", idx + 1, total),
            );

            if results.len() >= SEARCH_RESULT_LIMIT {
                break;
            }
        }

        Ok(results)
    }

    pub fn get_story_entry(&self, story_id: &str) -> Result<StoryEntry, String> {
        let stories = self.collect_stories_for_index()?;
        for indexed in stories {
            if indexed.story.story_id == story_id {
                return Ok(indexed.story);
            }
        }
        Err(format!("Story {} 不存在", story_id))
    }

    /// 提取匹配文本的上下文
    ///
    /// 使用归一化后文本查找匹配位置，再把"归一化字符索引"映射回"原文字节位置"，
    /// 避免 NFKC/去标点造成的字节长度变化导致越界或错位（bug A1）。
    fn extract_context(&self, content: &str, query: &str) -> String {
        if content.is_empty() || query.is_empty() {
            return String::new();
        }

        // Normalize both sides with the fuzzy pipeline for consistency with the
        // linear-scan fallback. `query` is expected to already be fuzzy-normalized
        // by the caller, but re-normalizing is idempotent and cheap.
        let query_norm = normalize_for_fuzzy(query);
        if query_norm.is_empty() {
            return String::new();
        }

        // Build a parallel mapping: for each normalized char, remember the
        // original char index it came from. This lets us map a match position
        // back to the original content without byte-length surprises.
        let mut norm_chars: Vec<char> = Vec::with_capacity(content.len());
        let mut origin_char_for_norm: Vec<usize> = Vec::with_capacity(content.len());
        for (orig_idx, ch) in content.replace("{@nickname}", "博士").chars().enumerate() {
            // The replace above shifts indices for any passage containing
            // `{@nickname}`, but for the common case it is benign. We still
            // compute the best-effort mapping using the *current* char
            // position after the textual substitution — users search "博士"
            // and expect the snippet to show "博士" as well.
            for normalized in ch.to_lowercase() {
                let nfkc: String = normalized.nfkc().collect();
                for nch in nfkc.chars() {
                    if unicode_normalization::char::canonical_combining_class(nch) != 0 {
                        continue;
                    }
                    if nch.is_whitespace() || is_common_punctuation(nch) {
                        continue;
                    }
                    norm_chars.push(nch);
                    origin_char_for_norm.push(orig_idx);
                }
            }
        }

        let norm_text: String = norm_chars.iter().collect();
        if norm_text.is_empty() {
            return String::new();
        }

        // Try full query first, then each whitespace-delimited token as a
        // second-chance match. `query_norm` is already stripped of whitespace
        // via normalize_for_fuzzy so the split is mostly irrelevant; kept for
        // symmetry with how callers historically passed multi-token queries.
        let mut probes = Vec::new();
        probes.push(query_norm.as_str());

        for probe in probes {
            if probe.is_empty() {
                continue;
            }
            if let Some(pos_byte) = norm_text.find(probe) {
                // Byte position in `norm_text` → norm char index.
                let norm_char_index = norm_text[..pos_byte].chars().count();
                if norm_char_index >= origin_char_for_norm.len() {
                    continue;
                }
                let origin_char_start = origin_char_for_norm[norm_char_index];
                let probe_char_len = probe.chars().count();
                // Original snippet window around the matched characters.
                let origin_chars: Vec<char> = content.chars().collect();
                if origin_chars.is_empty() {
                    return String::new();
                }
                let window = 50usize;
                let snippet_start = origin_char_start.saturating_sub(window);
                let snippet_end = (origin_char_start + probe_char_len + window).min(origin_chars.len());
                let snippet: String = origin_chars[snippet_start..snippet_end].iter().collect();
                if snippet.is_empty() {
                    continue;
                }
                return format!("...{}...", snippet.trim());
            }
        }

        String::new()
    }

    pub fn get_main_stories_grouped(&self) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
        if !self.is_installed() {
            return Err("NOT_INSTALLED".to_string());
        }

        let story_review_file = self
            .data_dir
            .join("zh_CN/gamedata/excel/story_review_table.json");

        let content = fs::read_to_string(&story_review_file)
            .map_err(|e| format!("Failed to read story review file: {}", e))?;

        let data: HashMap<String, Value> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse story review data: {}", e))?;

        // 按分组ID收集主线剧情
        let mut groups: Vec<(String, String, Vec<StoryEntry>)> = Vec::new();

        for (id, value) in data.iter() {
            if let Some(et) = value.get("entryType").and_then(|v| v.as_str()) {
                if et == "MAINLINE" {
                    let group_name = value
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("未知章节");

                    if let Some(unlock_datas) =
                        value.get("infoUnlockDatas").and_then(|v| v.as_array())
                    {
                        let mut stories = Vec::new();
                        for unlock_data in unlock_datas {
                            if let Ok(story) =
                                serde_json::from_value::<StoryEntry>(unlock_data.clone())
                            {
                                stories.push(story);
                            }
                        }
                        stories.sort_by_key(|s| s.story_sort);
                        groups.push((id.clone(), group_name.to_string(), stories));
                    }
                }
            }
        }

        groups.sort_by(|a, b| compare_story_group_ids(&a.0, &b.0));

        Ok(groups
            .into_iter()
            .map(|(_, name, stories)| (name, stories))
            .collect())
    }

    pub fn get_activity_stories_grouped(&self) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
        if !self.is_installed() {
            return Err("NOT_INSTALLED".to_string());
        }

        let story_review_file = self
            .data_dir
            .join("zh_CN/gamedata/excel/story_review_table.json");

        let content = fs::read_to_string(&story_review_file)
            .map_err(|e| format!("Failed to read story review file: {}", e))?;

        let data: HashMap<String, Value> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse story review data: {}", e))?;

        let mut groups: Vec<(String, Vec<StoryEntry>, i64, String)> = Vec::new();

        for (_id, value) in data.iter() {
            if let Some(et) = value.get("entryType").and_then(|v| v.as_str()) {
                if et == "ACTIVITY" || et == "MINI_ACTIVITY" {
                    let activity_name = value
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("未知活动");

                    if let Some(unlock_datas) =
                        value.get("infoUnlockDatas").and_then(|v| v.as_array())
                    {
                        let mut stories = Vec::new();
                        for unlock_data in unlock_datas {
                            if let Ok(story) =
                                serde_json::from_value::<StoryEntry>(unlock_data.clone())
                            {
                                stories.push(story);
                            }
                        }

                        if !stories.is_empty() {
                            stories.sort_by_key(|s| s.story_sort);
                            let start_time = value
                                .get("startTime")
                                .and_then(|v| v.as_i64())
                                .unwrap_or(i64::MAX);
                            let normalized_start = if start_time <= 0 {
                                i64::MAX
                            } else {
                                start_time
                            };
                            let sort_id = value
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or_else(|| _id.as_str());

                            groups.push((
                                activity_name.to_string(),
                                stories,
                                normalized_start,
                                sort_id.to_string(),
                            ));
                        }
                    }
                }
            }
        }

        // 按活动开始时间排序（旧活动在前，时间缺失的放在末尾）
        groups.sort_by(|a, b| match a.2.cmp(&b.2) {
            Ordering::Equal => compare_story_group_ids(&a.3, &b.3),
            other => other,
        });

        Ok(groups
            .into_iter()
            .map(|(name, stories, _, _)| (name, stories))
            .collect())
    }

    pub fn get_sidestory_stories_grouped(&self) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
        if !self.is_installed() {
            return Err("NOT_INSTALLED".to_string());
        }

        let story_review_file = self
            .data_dir
            .join("zh_CN/gamedata/excel/story_review_table.json");

        let content = fs::read_to_string(&story_review_file)
            .map_err(|e| format!("Failed to read story review file: {}", e))?;

        let data: HashMap<String, Value> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse story review data: {}", e))?;

        let mut groups: Vec<(String, Vec<StoryEntry>, String)> = Vec::new();

        for (id, value) in data.iter() {
            let Some(entry_type) = value.get("entryType").and_then(|v| v.as_str()) else {
                continue;
            };
            let act_type = value.get("actType").and_then(|v| v.as_str()).unwrap_or("");
            // 支线=大型活动（ACTIVITY + ACTIVITY_STORY）
            if entry_type == "ACTIVITY" && act_type == "ACTIVITY_STORY" {
                let group_name = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("支线剧情");

                if let Some(unlock_datas) = value.get("infoUnlockDatas").and_then(|v| v.as_array())
                {
                    let mut stories = Vec::new();
                    for unlock_data in unlock_datas {
                        if let Ok(story) = serde_json::from_value::<StoryEntry>(unlock_data.clone())
                        {
                            stories.push(story);
                        }
                    }
                    if !stories.is_empty() {
                        stories.sort_by_key(|s| s.story_sort);
                        groups.push((group_name.to_string(), stories, id.clone()));
                    }
                }
            }
        }

        groups.sort_by(|a, b| compare_story_group_ids(&a.2, &b.2));
        Ok(groups
            .into_iter()
            .map(|(name, stories, _)| (name, stories))
            .collect())
    }

    pub fn get_roguelike_stories_grouped(&self) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
        if !self.is_installed() {
            return Err("NOT_INSTALLED".to_string());
        }

        // 首先读取 meta，提取 contentPath -> desc 映射（用于更友好的命名）
        let meta_file = self
            .data_dir
            .join("zh_CN/gamedata/excel/story_review_meta_table.json");
        let meta_content = fs::read_to_string(&meta_file)
            .map_err(|e| format!("Failed to read story review meta file: {}", e))?;
        let meta_value: Value = serde_json::from_str(&meta_content)
            .map_err(|e| format!("Failed to parse story review meta data: {}", e))?;

        let mut path_desc_map: HashMap<String, String> = HashMap::new();
        // 广义扫描：meta 中所有含 contentPath 的对象都尝试收集（兼容结构变动）
        fn collect_content_paths(map: &mut HashMap<String, String>, val: &Value) {
            match val {
                Value::Object(obj) => {
                    if let Some(cp) = obj.get("contentPath").and_then(|x| x.as_str()) {
                        let lower = cp.to_ascii_lowercase();
                        if lower.starts_with("obt/roguelike/") {
                            let desc = obj
                                .get("desc")
                                .and_then(|x| x.as_str())
                                .or_else(|| obj.get("name").and_then(|x| x.as_str()))
                                .or_else(|| obj.get("rawBrief").and_then(|x| x.as_str()))
                                .unwrap_or("")
                                .trim()
                                .to_string();
                            if !desc.is_empty() {
                                map.insert(lower, desc);
                            }
                        }
                    }
                    for v in obj.values() {
                        collect_content_paths(map, v);
                    }
                }
                Value::Array(arr) => {
                    for v in arr {
                        collect_content_paths(map, v);
                    }
                }
                _ => {}
            }
        }
        collect_content_paths(&mut path_desc_map, &meta_value);

        // 使用 story_table 作为权威来源，枚举所有 Obt/Roguelike 文本
        let story_table_file = self.data_dir.join("zh_CN/gamedata/excel/story_table.json");
        let story_table_content = fs::read_to_string(&story_table_file)
            .map_err(|e| format!("Failed to read story table file: {}", e))?;
        let table_obj: HashMap<String, Value> = serde_json::from_str(&story_table_content)
            .map_err(|e| format!("Failed to parse story table: {}", e))?;

        let mut grouped: HashMap<String, Vec<StoryEntry>> = HashMap::new();
        let mut counters: HashMap<String, i32> = HashMap::new();

        for (key, _v) in table_obj.into_iter() {
            let lower = key.to_ascii_lowercase();
            if !lower.starts_with("obt/roguelike/") {
                continue;
            }
            let group_key = lower
                .split('/')
                .nth(2)
                .map(|s| s.to_uppercase())
                .unwrap_or_else(|| "ROGUE".to_string());
            let sort = counters
                .entry(group_key.clone())
                .and_modify(|x| *x += 1)
                .or_insert(1);
            let name = path_desc_map.get(&lower).cloned().unwrap_or_else(|| {
                // 取最后一段作为兜底标题
                key.split('/').last().unwrap_or(&key).to_string()
            });

            let entry = StoryEntry {
                story_id: key.clone(),
                story_name: name,
                story_code: None,
                story_group: group_key.clone(),
                story_sort: *sort,
                avg_tag: None,
                story_txt: lower.clone(),
                story_info: None,
                story_review_type: "ROGUELIKE".to_string(),
                unlock_type: "NONE".to_string(),
                story_dependence: None,
                story_can_show: None,
                story_can_enter: None,
                stage_count: None,
                required_stages: None,
                cost_item_type: None,
                cost_item_id: None,
                cost_item_count: None,
            };

            grouped.entry(group_key).or_default().push(entry);
        }

        let mut out: Vec<(String, Vec<StoryEntry>)> = grouped
            .into_iter()
            .map(|(name, mut stories)| {
                stories.sort_by_key(|e| e.story_sort);
                (name, stories)
            })
            .collect();
        out.sort_by(|a, b| compare_story_group_ids(&a.0, &b.0));
        Ok(out)
    }

    pub fn get_memory_stories(&self) -> Result<Vec<StoryEntry>, String> {
        if !self.is_installed() {
            return Err("NOT_INSTALLED".to_string());
        }

        let story_review_file = self
            .data_dir
            .join("zh_CN/gamedata/excel/story_review_table.json");

        let content = fs::read_to_string(&story_review_file)
            .map_err(|e| format!("Failed to read story review file: {}", e))?;

        let data: HashMap<String, Value> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse story review data: {}", e))?;

        let stories = self.parse_stories_by_entry_type(&data, "NONE")?;
        Ok(stories)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_story_info_supports_uc_prefix() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_root = std::env::temp_dir().join(format!("story_reader_test_{}", timestamp));
        let data_dir = temp_root.join("ArknightsGameData");
        let info_dir = data_dir.join("zh_CN/gamedata/story/[uc]info/demo");
        fs::create_dir_all(&info_dir).unwrap();
        fs::write(info_dir.join("sample.txt"), "test summary").unwrap();

        let service = DataService {
            data_dir: data_dir.clone(),
            index_db_path: temp_root.join("story_index.db"),
        };

        let content = service
            .read_story_info("info/demo/sample")
            .expect("should read summary from [uc]info directory");
        assert_eq!(content, "test summary");

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn normalize_for_fuzzy_strips_whitespace_and_punctuation() {
        assert_eq!(normalize_for_fuzzy("凯尔希 阿米娅"), "凯尔希阿米娅");
        assert_eq!(normalize_for_fuzzy("凯尔希，阿米娅！"), "凯尔希阿米娅");
        assert_eq!(normalize_for_fuzzy("Kal'tsit"), "kaltsit");
        // NFKC folds full-width alphanumerics to half-width.
        assert_eq!(normalize_for_fuzzy("ＡＢＣ１２３"), "abc123");
    }

    #[test]
    fn normalize_for_fuzzy_replaces_nickname() {
        assert_eq!(
            normalize_for_fuzzy("{@nickname}，你好"),
            "博士你好"
        );
    }

    #[test]
    fn split_query_terms_basic() {
        let terms = split_query_terms("凯尔希 阿米娅");
        assert_eq!(terms, vec!["凯尔希", "阿米娅"]);
    }

    #[test]
    fn split_query_terms_quoted_phrase() {
        let terms = split_query_terms("\"凯尔希 阿米娅\"");
        // Quoted phrase collapses internal whitespace because of fuzzy normalization.
        assert_eq!(terms, vec!["凯尔希阿米娅"]);
    }

    #[test]
    fn split_query_terms_drops_or_and_not_prefix() {
        let terms = split_query_terms("凯尔希 or 阿米娅 -博士");
        // `or` is dropped and NOT prefix becomes a positive term in fallback.
        assert_eq!(terms, vec!["凯尔希", "阿米娅", "博士"]);
    }

    #[test]
    fn fts_query_escapes_specials_and_is_nonempty() {
        let q = DataService::build_fts_query_advanced("凯尔希*").expect("non-empty");
        assert!(!q.contains('*'));
        // The phrase must still contain the three CJK chars spaced.
        assert!(q.contains("凯"));
        assert!(q.contains("尔"));
    }

    #[test]
    fn fts_query_long_cjk_expands_to_bigram_and() {
        let q = DataService::build_fts_query_advanced("凯尔希阿米娅").expect("non-empty");
        // Long CJK terms (>=4 chars) expand to overlapping bigrams joined by AND.
        assert!(q.contains("AND"));
        assert!(q.contains("凯 尔"));
        assert!(q.contains("米 娅"));
    }

    #[test]
    fn fts_query_short_cjk_is_strict_phrase() {
        let q = DataService::build_fts_query_advanced("凯尔希").expect("non-empty");
        assert_eq!(q.trim(), "\"凯 尔 希\"");
    }

    #[test]
    fn fts_query_ascii_gets_prefix_star() {
        let q = DataService::build_fts_query_advanced("prts").expect("non-empty");
        assert_eq!(q.trim(), "prts*");
    }

    #[test]
    fn fts_query_pure_punctuation_returns_none() {
        // After sanitization nothing is left.
        assert!(DataService::build_fts_query_advanced("()**").is_none());
    }

    #[test]
    fn fts_query_or_connective() {
        let q = DataService::build_fts_query_advanced("阿米娅 or 凯尔希").expect("non-empty");
        assert!(q.contains("OR"));
    }

    #[test]
    fn fts_query_not_prefix() {
        let q = DataService::build_fts_query_advanced("-凯尔希 博士").expect("non-empty");
        assert!(q.contains("NOT"));
    }
}
