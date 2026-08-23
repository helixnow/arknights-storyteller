use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use unicode_normalization::UnicodeNormalization;
use zip::ZipArchive;

use crate::models::{
    Activity, Chapter, SearchDebugResponse, SearchResult, SearchResultsPage, SegmentHit,
    SegmentSearchPage, StoryCategory, StoryEntry, StoryIndexStatus, StoryPreviewToken, StorySegment,
};
use crate::parser::parse_story_text;

const REPO_API_URL: &str = "https://api.github.com/repos/Kengxxiao/ArknightsGameData";
const REPO_DOWNLOAD_URL: &str = "https://codeload.github.com/Kengxxiao/ArknightsGameData/zip";
const DEFAULT_BRANCH: &str = "master";
const VERSION_FILE: &str = "version.json";
const SEARCH_RESULT_LIMIT: usize = 500;
/// 建立 TCP/TLS 连接的上限。连不上就是连不上，多等也不会自己好。
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 单次 socket 操作的上限。blocking 版 reqwest 的 `timeout` 按「每次
/// connect/read/write 操作」计时，而不是整个响应的总时限：几百 MB 的数
/// 据包只要每个 8KB 块能在窗口内到达就不受影响，真正断流的连接则会在
/// 一分钟内报错，而不是永远挂着。
const HTTP_OP_TIMEOUT: Duration = Duration::from_secs(60);
/// Bump when any of: FTS schema, tokenizer rules, `searchable_text` format,
/// or the set of stories that gets indexed. A bump drops both FTS tables at
/// open time, so the next `rebuild_story_index_*` starts from scratch.
///
/// v4 = added the segment-level FTS table `story_segment_index`, so hits can
///      carry a `(story_id, segment_index)` pair instead of story-only.
/// v5 = parser recognises `[Image]` / `[Background]` / `[PlayMusic]` and
///      dialogue carries `characterId`; new segment kinds shift every stored
///      segment index.
/// v6 = dropped jieba in favour of char-level CJK tokenization (much smaller
///      binary). Every `tokenized_content` / `tokenized_text` value stored by
///      an older build is in the old word-level form and would never match
///      the new char-level queries, hence the rebuild.
/// v7 = segment post-processing de-dupes consecutive same-token `Image`
///      segments (matching what the reader renders) and roguelike stories
///      join the index; both shift stored segment indices.
const INDEX_VERSION: i32 = 7;

const META_TOTAL_COUNT: &str = "total_count";
const META_SEGMENT_TOTAL: &str = "segment_total";
/// 建这份索引时数据集的身份（commit + 三张表的大小/mtime + 篇数 + 索引版本）。
/// 对得上就说明索引已经是最新的，重建可以整个跳过。
const META_DATASET_FINGERPRINT: &str = "dataset_fingerprint";

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

/// 目录里的一篇剧情。同一章节 / 活动下的上百个条目共享同一份分类名与
/// 分类标签，所以这三个字段用 `Arc<str>` 而不是各自持有一份 `String`。
#[derive(Clone)]
struct IndexedStory {
    category_name: Arc<str>,
    /// `<类型> | <分组名>`，建目录时算一次。索引重建和线性扫描都是每篇剧情
    /// 都要用的热路径，之前每次都重新 format 一遍。
    category_label: Arc<str>,
    story: StoryEntry,
}

const REVIEW_TABLE_REL: &str = "zh_CN/gamedata/excel/story_review_table.json";
const REVIEW_META_TABLE_REL: &str = "zh_CN/gamedata/excel/story_review_meta_table.json";
const STORY_TABLE_REL: &str = "zh_CN/gamedata/excel/story_table.json";

/// Identity of the installed dataset. `story_review_table.json` is several
/// megabytes and every list/lookup command used to re-read and re-parse it,
/// so the derived catalog is memoized under this fingerprint.
///
/// The `version.json` commit is the primary key — a sync or a manual import
/// always rewrites it. Sizes and mtimes of the three tables we actually read
/// are folded in as a safety net for datasets swapped in place (or dropped in
/// by hand) without the commit ever changing.
#[derive(Clone, PartialEq, Eq, Debug)]
struct CatalogFingerprint {
    commit: String,
    fetched_at: i64,
    files: Vec<(u64, i128)>,
}

/// Everything the story-list / lookup commands need, derived from one pass
/// over `story_review_table.json` (plus the roguelike tables).
struct StoryCatalog {
    /// Every indexable story, sorted by `story_id` — the order
    /// `rebuild_story_index` and the linear-scan fallback walk.
    stories: Vec<IndexedStory>,
    /// `story_id` → position in `stories`.
    by_id: HashMap<String, usize>,
    /// `story_group` → positions in `stories`, ordered by `story_sort`.
    by_group: HashMap<String, Vec<usize>>,
    main_groups: Vec<(String, Vec<StoryEntry>)>,
    activity_groups: Vec<(String, Vec<StoryEntry>)>,
    sidestory_groups: Vec<(String, Vec<StoryEntry>)>,
    roguelike_groups: Vec<(String, Vec<StoryEntry>)>,
    /// Why the roguelike tables could not be read, if they could not be. The
    /// rest of the catalog stays usable; only `get_roguelike_stories_grouped`
    /// surfaces the failure.
    roguelike_error: Option<String>,
    memory_stories: Vec<StoryEntry>,
}

impl StoryCatalog {
    /// `(剧情名, `<类型> | <分组名>`)`，给搜索结果贴显示标签用。之前这份
    /// 映射是单独一张 `HashMap<String, (String, String)>`，等于把每篇剧情的
    /// 名字和标签又存了一遍；现在直接落到 `stories` 上查。
    fn label_for(&self, story_id: &str) -> Option<(&str, &str)> {
        self.by_id.get(story_id).map(|idx| {
            let item = &self.stories[*idx];
            (item.story.story_name.as_str(), &*item.category_label)
        })
    }
}

struct CatalogSlot {
    fingerprint: CatalogFingerprint,
    catalog: Arc<StoryCatalog>,
}

/// Keyed by data directory so that several `DataService` instances (the app
/// has one, tests have many) never evict each other.
static CATALOG_CACHE: Mutex<Option<HashMap<PathBuf, CatalogSlot>>> = Mutex::new(None);

/// A single app only ever needs one entry; the cap just stops long test runs
/// from holding every temp dataset they ever created.
const CATALOG_CACHE_CAPACITY: usize = 16;

/// 每个索引库一把重建锁，见 `rebuild_story_index_inner`。
static INDEX_BUILD_LOCKS: Mutex<Option<HashMap<PathBuf, Arc<Mutex<()>>>>> = Mutex::new(None);

/// 真正从头重建过多少次（跳过的不算）。测试靠它证明「已是最新就不干活」。
#[cfg(test)]
static INDEX_BUILD_LOG: Mutex<Option<HashMap<PathBuf, usize>>> = Mutex::new(None);

#[cfg(test)]
fn index_build_count(index_db_path: &Path) -> usize {
    INDEX_BUILD_LOG
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|map| map.get(index_db_path).copied())
        .unwrap_or(0)
}

/// How many times each data directory has been parsed from scratch. Tests use
/// it to prove the memoization actually holds (and actually gives way when the
/// dataset changes).
#[cfg(test)]
static CATALOG_BUILD_LOG: Mutex<Option<HashMap<PathBuf, usize>>> = Mutex::new(None);

#[cfg(test)]
fn catalog_build_count(data_dir: &Path) -> usize {
    CATALOG_BUILD_LOG
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|map| map.get(data_dir).copied())
        .unwrap_or(0)
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

/// `extract_zip_at` runs both from Tauri commands and from unit tests, where
/// there is no `AppHandle` to emit to.
fn emit_progress_opt(
    app: Option<&AppHandle>,
    phase: impl Into<String>,
    current: usize,
    total: usize,
    message: impl Into<String>,
) {
    if let Some(app) = app {
        emit_progress(app, phase, current, total, message);
    }
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

/// 把一个查询词切成「索引里真的会成词」的原子：ASCII 字母数字连成一段，
/// CJK 逐字，其余字符（标点、假名、符号）在 `tokenize_for_fts` 里根本不会
/// 进索引，这里也一并丢掉。
///
/// 必须和 `DataService::term_to_clause` 的切分保持一致——那边生成 FTS 子句，
/// 这边生成线性扫描的判定条件，两者一旦分叉，同一个查询在「索引可用」和
/// 「索引没建好」两种状态下就会给出不同的结果集。
fn split_match_atoms(text: &str) -> Vec<String> {
    let mut atoms: Vec<String> = Vec::new();
    let mut ascii = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            ascii.push(ch.to_ascii_lowercase());
        } else {
            if !ascii.is_empty() {
                atoms.push(std::mem::take(&mut ascii));
            }
            if is_cjk(ch) {
                atoms.push(ch.to_string());
            }
        }
    }
    if !ascii.is_empty() {
        atoms.push(ascii);
    }
    atoms
}

/// 一个查询词。`atoms` 里的每一项都必须出现，命中方式与 FTS 侧一一对应：
///
/// * 普通词 `凯尔希` → FTS `("凯" AND "尔" AND "希")`，原子 = 逐字，
///   出现在文中任意位置即可（不要求相邻）。
/// * 引号短语 `"凯尔希"` → FTS `"凯 尔 希"`，原子只有一个 = 整串，
///   因为 `normalize_for_fuzzy` 已经把空白和标点去掉了，`contains` 恰好
///   等价于 FTS 短语要求的「token 连续」。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Term {
    /// 归一化后的完整词，用来给预览片段定位。
    text: String,
    atoms: Vec<String>,
}

impl Term {
    /// `text` 必须已经过 `normalize_for_fuzzy`。返回 `None` 表示这个词在
    /// 索引侧同样产生不了任何子句，两边一起当它不存在。
    fn word(text: String) -> Option<Self> {
        let atoms = split_match_atoms(&text);
        (!atoms.is_empty()).then(|| Self { text, atoms })
    }

    fn phrase(text: String) -> Option<Self> {
        let atoms = split_match_atoms(&text);
        if atoms.is_empty() {
            return None;
        }
        let joined = atoms.concat();
        Some(Self {
            text,
            atoms: vec![joined],
        })
    }

    /// FTS 的 `MATCH` 判定是行级的：`A AND B` 允许 A 命中一列、B 命中另一列。
    /// 这里同样允许不同原子落在不同的 haystack 上。
    fn matches(&self, haystacks: &[&str]) -> bool {
        self.atoms
            .iter()
            .all(|atom| haystacks.iter().any(|hay| hay.contains(atom.as_str())))
    }

    /// 取上下文片段时依次尝试的探针：先整词，再退回单个原子。
    fn snippet_probes(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.text.as_str()).chain(self.atoms.iter().map(String::as_str))
    }
}

/// A user query broken down for the linear-scan fallback, mirroring the
/// boolean semantics of `build_fts_query_advanced`: AND between groups, OR
/// inside a group, and `-term` excludes.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct QueryTerms {
    /// Positive terms. Every group must be satisfied (AND); within a group
    /// any single alternative suffices (OR).
    positive: Vec<Vec<Term>>,
    /// Terms introduced with a leading `-`; a document matching any of them
    /// is rejected.
    negative: Vec<Term>,
}

impl QueryTerms {
    /// The first positive term, used to centre the preview snippet.
    fn primary(&self) -> Option<&Term> {
        self.positive.first().and_then(|group| group.first())
    }

    /// Are all positive groups satisfied by at least one of `haystacks`?
    /// Callers must check `excluded_by` separately — a title-only fast path
    /// cannot see the body text a `-term` might live in.
    fn positives_match(&self, haystacks: &[&str]) -> bool {
        if self.positive.is_empty() {
            return false;
        }
        self.positive
            .iter()
            .all(|group| group.iter().any(|term| term.matches(haystacks)))
    }

    fn excluded_by(&self, haystacks: &[&str]) -> bool {
        self.negative.iter().any(|term| term.matches(haystacks))
    }
}

/// Split a raw user query into logical terms for the fallback scanner.
/// Quoted phrases are kept intact, a literal `or` joins the surrounding terms
/// into one OR group, and a leading `-` marks an exclusion. Returns already
/// fuzzy-normalized terms.
fn split_query_terms(query: &str) -> QueryTerms {
    struct Raw {
        text: String,
        is_not: bool,
        is_quoted: bool,
    }

    fn flush_bare(buf: &mut String, terms: &mut Vec<Raw>) {
        if buf.is_empty() {
            return;
        }
        let raw = std::mem::take(buf);
        let is_not = raw.starts_with('-');
        let normalized = normalize_for_fuzzy(&raw);
        if normalized.is_empty() {
            return;
        }
        terms.push(Raw {
            text: normalized,
            is_not,
            is_quoted: false,
        });
    }

    fn flush_quoted(buf: &mut String, terms: &mut Vec<Raw>, is_not: bool) {
        let phrase = std::mem::take(buf);
        let normalized = normalize_for_fuzzy(&phrase);
        if normalized.is_empty() {
            return;
        }
        terms.push(Raw {
            text: normalized,
            is_not,
            is_quoted: true,
        });
    }

    let mut raw_terms: Vec<Raw> = Vec::new();
    let mut buf = String::new();
    let mut in_quotes = false;
    // `-"凯尔希"`：减号落在引号之前，`normalize_for_fuzzy` 会把孤零零的 `-`
    // 抹成空串。先记下来，否则否定短语会被当成肯定短语，语义正好反过来。
    let mut quote_is_not = false;

    for ch in query.chars() {
        match ch {
            '"' => {
                if in_quotes {
                    in_quotes = false;
                    flush_quoted(&mut buf, &mut raw_terms, quote_is_not);
                    quote_is_not = false;
                } else {
                    quote_is_not = buf == "-";
                    flush_bare(&mut buf, &mut raw_terms);
                    in_quotes = true;
                }
            }
            c if c.is_whitespace() && !in_quotes => {
                flush_bare(&mut buf, &mut raw_terms);
            }
            _ => buf.push(ch),
        }
    }
    // 引号没闭合时按普通词收尾，和 `build_fts_query_advanced` 一致。
    if in_quotes && quote_is_not {
        buf.insert(0, '-');
    }
    flush_bare(&mut buf, &mut raw_terms);

    let mut out = QueryTerms::default();
    let mut pending_or = false;
    for raw in raw_terms {
        // 引号里的 `or` 是要搜的字面量，不是连接词。
        if !raw.is_quoted && raw.text == "or" {
            // `or` only connects when there is something on the left to
            // connect to; a leading `or` is just noise.
            pending_or = !out.positive.is_empty();
            continue;
        }
        let term = if raw.is_quoted {
            Term::phrase(raw.text)
        } else {
            Term::word(raw.text)
        };
        let Some(term) = term else { continue };
        if raw.is_not {
            out.negative.push(term);
            continue;
        }
        if pending_or {
            if let Some(group) = out.positive.last_mut() {
                group.push(term);
                pending_or = false;
                continue;
            }
        }
        pending_or = false;
        out.positive.push(vec![term]);
    }

    out
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
        self.data_dir.join(REVIEW_TABLE_REL).exists()
    }

    /// 返回运行时 character_table.json 路径（若已同步），供 character_table
    /// 模块刷新嵌入映射。
    pub fn character_table_path(&self) -> Option<PathBuf> {
        let p = self.data_dir.join("zh_CN/gamedata/excel/character_table.json");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    pub fn new(app_data_dir: PathBuf) -> Self {
        let service = Self {
            data_dir: app_data_dir.join("ArknightsGameData"),
            index_db_path: app_data_dir.join("story_index.db"),
        };
        // 上一次换入若恰好在两次改名之间崩溃/断电，data_dir 会消失、完整
        // 的旧数据却还躺在 `_old` 暂存目录里。开机先接回来，否则
        // is_installed 会误报「未安装」，用户以为数据凭空没了。`new` 只在
        // setup 里跑一次，任何命令（包括同步换入）都还没机会启动，此时
        // 动这些目录没有并发之忧。
        service.restore_data_dir_from_aside();
        service
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
            // Drop and recreate virtual tables with current schema.
            conn.execute_batch(
                "
                DROP TABLE IF EXISTS story_index;
                DROP TABLE IF EXISTS story_segment_index;
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
                CREATE VIRTUAL TABLE story_segment_index USING fts5(
                    story_id UNINDEXED,
                    segment_index UNINDEXED,
                    segment_type UNINDEXED,
                    character_name,
                    tokenized_text,
                    raw_text UNINDEXED,
                    tokenize = 'unicode61 remove_diacritics 2',
                    prefix='2 3'
                );
                ",
            )
            .map_err(|e| format!("Failed to (re)create indexes: {}", e))?;

            conn.execute(
                "INSERT INTO story_index_meta (key, value) VALUES ('index_version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![INDEX_VERSION.to_string()],
            )
            .map_err(|e| format!("Failed to update index version: {}", e))?;
        } else {
            // Ensure tables exist (fresh install / first open after boot).
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
                CREATE VIRTUAL TABLE IF NOT EXISTS story_segment_index USING fts5(
                    story_id UNINDEXED,
                    segment_index UNINDEXED,
                    segment_type UNINDEXED,
                    character_name,
                    tokenized_text,
                    raw_text UNINDEXED,
                    tokenize = 'unicode61 remove_diacritics 2',
                    prefix='2 3'
                );
                ",
            )
            .map_err(|e| format!("Failed to ensure index tables: {}", e))?;
        }

        Ok(())
    }

    fn clear_story_index(&self) -> Result<(), String> {
        // WAL 模式下 `-wal` / `-shm` 是数据库的一部分：只删主文件会让 SQLite
        // 用残留的 WAL 复活旧索引。
        for suffix in ["", "-wal", "-shm"] {
            let mut path = self.index_db_path.clone().into_os_string();
            path.push(suffix);
            let path = PathBuf::from(path);
            if path.exists() {
                fs::remove_file(&path)
                    .map_err(|e| format!("Failed to remove story index {:?}: {}", path, e))?;
            }
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

    /// Group-level cover token from `story_review_table.json`. Entries often
    /// carry a null `storyPic`, in which case the活动/章节 level art is the
    /// only thing we can hand the frontend.
    fn group_story_pic(value: &Value) -> Option<String> {
        ["storyPic", "storyEntryPicId", "storyPicId", "storyMainPicId"]
            .iter()
            .find_map(|key| {
                value
                    .get(key)
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
            })
    }

    /// Deserialize a group's `infoUnlockDatas`, backfilling the cover token
    /// from the group when the entry itself has none.
    fn parse_group_entries(value: &Value) -> Vec<StoryEntry> {
        let Some(unlock_datas) = value.get("infoUnlockDatas").and_then(|v| v.as_array()) else {
            return Vec::new();
        };
        let group_pic = Self::group_story_pic(value);
        unlock_datas
            .iter()
            .filter_map(|unlock_data| {
                serde_json::from_value::<StoryEntry>(unlock_data.clone()).ok()
            })
            .map(|mut story| {
                if story
                    .story_pic
                    .as_ref()
                    .map(|p| p.trim().is_empty())
                    .unwrap_or(true)
                {
                    story.story_pic = group_pic.clone();
                }
                story
            })
            .collect()
    }

    fn collect_indexed_stories(
        data: &HashMap<String, Value>,
        roguelike_groups: &[(String, Vec<StoryEntry>)],
    ) -> Vec<IndexedStory> {
        let mut seen_ids = HashSet::new();
        let mut stories = Vec::new();

        for (entry_id, value) in data.iter() {
            let entry_type = value
                .get("entryType")
                .and_then(|v| v.as_str())
                .unwrap_or("UNKNOWN");

            let category_name = Self::resolve_category_name(entry_type, entry_id, value);
            // 一个分组算一次，组内所有条目共享同一份字符串。
            let category_label: Arc<str> =
                Self::format_category_label(entry_type, &category_name).into();
            let category_name: Arc<str> = category_name.into();

            for story in Self::parse_group_entries(value) {
                if story.story_txt.trim().is_empty() {
                    continue;
                }
                if seen_ids.insert(story.story_id.clone()) {
                    stories.push(IndexedStory {
                        category_name: Arc::clone(&category_name),
                        category_label: Arc::clone(&category_label),
                        story,
                    });
                }
            }
        }

        // Roguelike scripts live in `story_table.json`, not in the review
        // table. Without them 肉鸽 is unsearchable and `get_story_entry` /
        // `get_story_neighbors` fail for every roguelike reader session.
        for (group_key, group_stories) in roguelike_groups {
            let category_name: Arc<str> = group_key.as_str().into();
            let category_label: Arc<str> =
                Self::format_category_label("ROGUELIKE", group_key).into();
            for story in group_stories {
                if story.story_txt.trim().is_empty() {
                    continue;
                }
                if seen_ids.insert(story.story_id.clone()) {
                    stories.push(IndexedStory {
                        category_name: Arc::clone(&category_name),
                        category_label: Arc::clone(&category_label),
                        story: story.clone(),
                    });
                }
            }
        }

        stories.sort_by(|a, b| a.story.story_id.cmp(&b.story.story_id));
        stories
    }

    /// Cheap identity check for the installed dataset — one small read plus
    /// three `stat` calls, versus the multi-megabyte parse it guards.
    fn catalog_fingerprint(&self) -> CatalogFingerprint {
        let version = self.read_version();
        let files = [REVIEW_TABLE_REL, REVIEW_META_TABLE_REL, STORY_TABLE_REL]
            .iter()
            .map(|rel| {
                fs::metadata(self.data_dir.join(rel))
                    .map(|meta| {
                        let modified = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_nanos() as i128)
                            .unwrap_or(-1);
                        (meta.len(), modified)
                    })
                    .unwrap_or((0, -1))
            })
            .collect();

        CatalogFingerprint {
            commit: version
                .as_ref()
                .map(|v| v.commit.clone())
                .unwrap_or_default(),
            fetched_at: version.as_ref().map(|v| v.fetched_at).unwrap_or(0),
            files,
        }
    }

    /// Memoized story catalog. Rebuilt whenever the dataset fingerprint
    /// changes; see `CatalogFingerprint`.
    fn catalog(&self) -> Result<Arc<StoryCatalog>, String> {
        if !self.is_installed() {
            return Err("NOT_INSTALLED".to_string());
        }

        let fingerprint = self.catalog_fingerprint();

        {
            let guard = CATALOG_CACHE.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(slot) = guard.as_ref().and_then(|map| map.get(&self.data_dir)) {
                if slot.fingerprint == fingerprint {
                    return Ok(Arc::clone(&slot.catalog));
                }
            }
        }

        // Built outside the lock: parsing takes seconds on a cold start and
        // must not serialize unrelated data directories. A concurrent caller
        // may duplicate the work once, which is cheaper than holding the lock.
        let catalog = Arc::new(self.build_catalog()?);

        let mut guard = CATALOG_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        let map = guard.get_or_insert_with(HashMap::new);
        if map.len() >= CATALOG_CACHE_CAPACITY && !map.contains_key(&self.data_dir) {
            map.clear();
        }
        map.insert(
            self.data_dir.clone(),
            CatalogSlot {
                fingerprint,
                catalog: Arc::clone(&catalog),
            },
        );
        Ok(catalog)
    }

    /// Parse the catalog ahead of the first command. Called on a background
    /// thread at startup so the story lists don't pay for it while the user is
    /// already looking at the app.
    pub fn prewarm_catalog(&self) {
        if let Err(err) = self.catalog() {
            if err != "NOT_INSTALLED" {
                eprintln!("[CATALOG] 预热失败: {}", err);
            }
        }
    }

    /// Drop the memoized catalog for this data directory. Called right after
    /// the dataset is replaced so a stale catalog can never be observed even
    /// if the new files happen to land on the same mtime/size.
    fn invalidate_catalog(&self) {
        let mut guard = CATALOG_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(map) = guard.as_mut() {
            map.remove(&self.data_dir);
        }
    }

    fn build_catalog(&self) -> Result<StoryCatalog, String> {
        #[cfg(test)]
        {
            let mut guard = CATALOG_BUILD_LOG.lock().unwrap_or_else(|e| e.into_inner());
            *guard
                .get_or_insert_with(HashMap::new)
                .entry(self.data_dir.clone())
                .or_insert(0) += 1;
        }

        let story_review_file = self.data_dir.join(REVIEW_TABLE_REL);
        let content = fs::read_to_string(&story_review_file)
            .map_err(|e| format!("Failed to read story review file: {}", e))?;
        let data: HashMap<String, Value> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse story review data: {}", e))?;
        drop(content);

        let (roguelike_groups, roguelike_error) = match self.collect_roguelike_groups() {
            Ok(groups) => (groups, None),
            Err(err) => {
                eprintln!("[CATALOG] 肉鸽剧情不可用: {}", err);
                (Vec::new(), Some(err))
            }
        };

        let stories = Self::collect_indexed_stories(&data, &roguelike_groups);

        let mut by_id = HashMap::with_capacity(stories.len());
        let mut by_group: HashMap<String, Vec<usize>> = HashMap::new();
        for (idx, item) in stories.iter().enumerate() {
            by_id.insert(item.story.story_id.clone(), idx);
            by_group
                .entry(item.story.story_group.clone())
                .or_default()
                .push(idx);
        }
        for positions in by_group.values_mut() {
            // `stories` is story_id-ordered, so a stable sort on storySort
            // keeps ties in id order — what `get_story_neighbors` used to do.
            positions.sort_by_key(|idx| stories[*idx].story.story_sort);
        }

        Ok(StoryCatalog {
            stories,
            by_id,
            by_group,
            main_groups: Self::build_main_groups(&data),
            activity_groups: Self::build_activity_groups(&data),
            sidestory_groups: Self::build_sidestory_groups(&data),
            roguelike_groups,
            roguelike_error,
            memory_stories: Self::build_memory_stories(&data),
        })
    }

    /// 把段落摊平成一段可索引的纯文本，追加到 `out`（每段前置一个换行）。
    /// 直接往一个缓冲区里写，避免先攒 `Vec<String>` 再 `join` ——那等于把
    /// 整篇剧情在内存里复制两遍。
    fn flatten_segments_into(out: &mut String, segments: &[StorySegment]) {
        for segment in segments {
            match segment {
                StorySegment::Dialogue {
                    character_name,
                    text,
                    ..
                } => {
                    out.push('\n');
                    out.push_str(character_name);
                    out.push('：');
                    out.push_str(text);
                }
                StorySegment::Narration { text }
                | StorySegment::System { text, .. }
                | StorySegment::Subtitle { text, .. }
                | StorySegment::Sticker { text, .. } => {
                    out.push('\n');
                    out.push_str(text);
                }
                StorySegment::Decision { options, .. } => {
                    // Use newline separator so each option is tokenized/indexed
                    // independently — users searching an option verbatim should
                    // still be able to hit the story. (bug A9)
                    for option in options {
                        out.push('\n');
                        out.push_str(option);
                    }
                }
                StorySegment::Header { title } => {
                    out.push('\n');
                    out.push_str(title);
                }
                StorySegment::Image { caption, .. } => {
                    if let Some(cap) = caption {
                        if !cap.trim().is_empty() {
                            out.push('\n');
                            out.push_str(cap);
                        }
                    }
                }
                StorySegment::Music { .. } => {
                    // BGM 指令不参与全文索引。
                }
            }
        }
    }

    /// 一篇剧情的可搜索全文：标题 + 摊平后的正文。索引里的 `raw_content`
    /// 就是它，线性扫描扫的也是它，两条路径必须同源。
    fn searchable_text(story_name: &str, segments: &[StorySegment]) -> String {
        let mut out = String::with_capacity(story_name.len() + segments.len() * 32);
        out.push_str(story_name);
        Self::flatten_segments_into(&mut out, segments);
        out
    }

    /// 读盘 + 解析 + 后处理，得到与索引完全一致的可搜索全文。
    /// 读不到（脚本缺失）时返回 `None`，调用方跳过这篇。
    fn story_searchable_text(&self, story_name: &str, story_txt: &str) -> Option<String> {
        let raw = self.read_story_text(story_txt).ok()?;
        let parsed = parse_story_text(&raw);
        drop(raw);
        let processed = Self::post_process_segments_for_index(&parsed.segments);
        drop(parsed);
        Some(Self::searchable_text(story_name, &processed))
    }

    /// Mirror the frontend's in-reader segment post-processing so the indices
    /// we store in `story_segment_index` line up with what the UI scrolls to
    /// when the user taps a search result. The two normalizations must stay
    /// in sync; if the reader's logic changes, bump `INDEX_VERSION` too.
    fn post_process_segments_for_index(segments: &[StorySegment]) -> Vec<StorySegment> {
        let cleaned: Vec<StorySegment> = segments
            .iter()
            .flat_map(|seg| -> Vec<StorySegment> {
                match seg {
                    StorySegment::Dialogue {
                        character_name,
                        text,
                        position,
                        character_id,
                    } => {
                        let normalized = text
                            .replace("\r\n", "\n")
                            .split('\n')
                            .map(|l| l.trim())
                            .filter(|l| !l.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n");
                        if normalized.is_empty() {
                            Vec::new()
                        } else {
                            vec![StorySegment::Dialogue {
                                character_name: character_name.clone(),
                                text: normalized,
                                position: position.clone(),
                                character_id: character_id.clone(),
                            }]
                        }
                    }
                    StorySegment::Narration { text } => {
                        let normalized = text
                            .replace("\r\n", "\n")
                            .split('\n')
                            .map(|l| l.trim())
                            .filter(|l| !l.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n");
                        if normalized.is_empty() {
                            Vec::new()
                        } else {
                            vec![StorySegment::Narration { text: normalized }]
                        }
                    }
                    StorySegment::Decision { options, values } => {
                        let opts: Vec<String> = options
                            .iter()
                            .map(|o| o.trim().to_string())
                            .filter(|o| !o.is_empty())
                            .collect();
                        if opts.is_empty() {
                            Vec::new()
                        } else {
                            vec![StorySegment::Decision {
                                options: opts,
                                values: values.clone(),
                            }]
                        }
                    }
                    // BGM 指令目前前端不渲染，直接丢弃。Image 段保留。
                    StorySegment::Music { .. } => Vec::new(),
                    other => vec![other.clone()],
                }
            })
            .collect();

        let mut merged: Vec<StorySegment> = Vec::with_capacity(cleaned.len());
        for seg in cleaned {
            // Scripts routinely set the same illustration twice in a row; the
            // reader collapses those, so the index has to as well or every
            // later segment index drifts.
            if let StorySegment::Image { token, .. } = &seg {
                if let Some(StorySegment::Image {
                    token: prev_token, ..
                }) = merged.last()
                {
                    if prev_token == token {
                        continue;
                    }
                }
            }
            if let StorySegment::Dialogue {
                character_name,
                text,
                position,
                character_id,
            } = &seg
            {
                if let Some(StorySegment::Dialogue {
                    character_name: prev_name,
                    text: prev_text,
                    position: _,
                    character_id: prev_cid,
                }) = merged.last_mut()
                {
                    if prev_name == character_name {
                        let joined = format!("{}\n{}", prev_text, text).replace("\n\n", "\n");
                        *prev_text = joined;
                        // keep first position, prefer existing cid else adopt new one
                        let _ = position;
                        if prev_cid.is_none() && character_id.is_some() {
                            *prev_cid = character_id.clone();
                        }
                        continue;
                    }
                }
            }
            merged.push(seg);
        }
        merged
    }

    /// Tokenize free text for the FTS index.
    ///
    /// Uses char-level tokenization for CJK text: each CJK character becomes
    /// its own token. ASCII alphanumeric runs are emitted as a single lowercase
    /// token. Punctuation and whitespace act as separators and are discarded.
    fn tokenize_for_fts(text: &str) -> Vec<String> {
        let normalized = normalize_nfkc_lower_strip_marks(text);
        if normalized.is_empty() {
            return Vec::new();
        }

        let mut tokens: Vec<String> = Vec::new();
        let mut ascii_buf = String::new();

        for ch in normalized.chars() {
            if ch.is_ascii_alphanumeric() {
                ascii_buf.push(ch.to_ascii_lowercase());
            } else {
                if !ascii_buf.is_empty() {
                    tokens.push(std::mem::take(&mut ascii_buf));
                }
                if is_cjk(ch) {
                    tokens.push(ch.to_string());
                }
                // Skip punctuation, whitespace, symbols
            }
        }
        if !ascii_buf.is_empty() {
            tokens.push(ascii_buf);
        }
        tokens
    }

    fn build_tokenized_content(text: &str) -> String {
        Self::tokenize_for_fts(text).join(" ")
    }

    // Build an FTS query using char-level CJK tokenization.
    //
    // For each user-supplied term:
    // - ASCII alnum runs → add `*` suffix for prefix match
    // - CJK text → split into individual characters, AND-joined
    // - Mixed tokens are split at ASCII/CJK boundaries.
    //
    // Quoted phrases bypass segmentation and are matched verbatim (after
    // character-level normalization) so users can pin exact sequences.
    //
    // Supports:
    //   * quoted phrase: `"foo bar"`
    //   * NOT: leading `-` on a term
    //   * OR: literal `or` token between terms
    //   * otherwise: implicit AND
    fn build_fts_query_advanced(raw_query: &str) -> Option<String> {
        let q = normalize_nfkc_lower_strip_marks(raw_query.trim());
        if q.is_empty() {
            return None;
        }

        #[derive(Clone)]
        struct UserTerm {
            text: String,
            is_not: bool,
            is_or_before: bool,
            is_quoted: bool,
        }

        let mut terms: Vec<UserTerm> = Vec::new();
        let mut buf = String::new();
        let mut in_quotes = false;
        let mut prev_was_or = false;
        let flush_bare = |buf: &mut String,
                          terms: &mut Vec<UserTerm>,
                          prev_was_or: &mut bool| {
            if buf.is_empty() {
                return;
            }
            let t = std::mem::take(buf);
            if t == "or" {
                *prev_was_or = true;
                return;
            }
            let is_not = t.starts_with('-');
            let content = if is_not { t.trim_start_matches('-').to_string() } else { t };
            if !content.is_empty() {
                terms.push(UserTerm {
                    text: content,
                    is_not,
                    is_or_before: *prev_was_or,
                    is_quoted: false,
                });
                *prev_was_or = false;
            }
        };

        // `-"凯尔希"`：减号在引号之前，`flush_bare` 会把孤零零的 `-` 丢掉。
        // 不记住它的话否定短语会变成肯定短语，语义正好反过来。
        let mut quote_is_not = false;
        for ch in q.chars() {
            match ch {
                '"' => {
                    if in_quotes {
                        in_quotes = false;
                        if !buf.is_empty() {
                            let phrase = std::mem::take(&mut buf);
                            terms.push(UserTerm {
                                text: phrase,
                                is_not: quote_is_not,
                                is_or_before: prev_was_or,
                                is_quoted: true,
                            });
                            prev_was_or = false;
                        }
                        quote_is_not = false;
                    } else {
                        quote_is_not = buf == "-";
                        flush_bare(&mut buf, &mut terms, &mut prev_was_or);
                        in_quotes = true;
                    }
                }
                c if c.is_whitespace() && !in_quotes => {
                    flush_bare(&mut buf, &mut terms, &mut prev_was_or);
                }
                _ => buf.push(ch),
            }
        }
        // 引号没闭合：剩下的部分退化成普通词，但否定语义要保住。
        if in_quotes && quote_is_not {
            buf.insert(0, '-');
        }
        flush_bare(&mut buf, &mut terms, &mut prev_was_or);
        if terms.is_empty() {
            return None;
        }

        fn is_fts_special(c: char) -> bool {
            matches!(c, '"' | '*' | ':' | '(' | ')' | '+' | '-' | '^' | '\\')
        }

        fn sanitize(s: &str) -> String {
            s.chars()
                .map(|c| if is_fts_special(c) || c.is_control() { ' ' } else { c })
                .collect::<String>()
                .trim()
                .to_string()
        }

        /// Convert a non-quoted term into an FTS clause.
        /// Returns an empty string if nothing meaningful remains.
        fn term_to_clause(raw: &str) -> String {
            let s = sanitize(raw);
            if s.is_empty() {
                return String::new();
            }

            // Pure ASCII alnum → prefix match.
            if s.chars().all(|c| c.is_ascii_alphanumeric()) {
                return format!("{}*", s);
            }

            // Char-level tokenization: split CJK into individual chars,
            // ASCII runs as prefix tokens.
            let mut tokens: Vec<String> = Vec::new();
            let mut ascii_buf = String::new();
            for ch in s.chars() {
                if ch.is_ascii_alphanumeric() {
                    ascii_buf.push(ch.to_ascii_lowercase());
                } else {
                    if !ascii_buf.is_empty() {
                        tokens.push(format!("{}*", std::mem::take(&mut ascii_buf)));
                    }
                    if is_cjk(ch) {
                        tokens.push(format!("\"{}\"", ch));
                    }
                    // skip punctuation
                }
            }
            if !ascii_buf.is_empty() {
                tokens.push(format!("{}*", ascii_buf));
            }

            if tokens.is_empty() {
                String::new()
            } else if tokens.len() == 1 {
                tokens.into_iter().next().unwrap()
            } else {
                format!("({})", tokens.join(" AND "))
            }
        }

        /// A quoted phrase must match verbatim. Split into char-level tokens
        /// and wrap as an FTS phrase so order is preserved.
        fn quoted_to_clause(raw: &str) -> String {
            let s = sanitize(raw);
            if s.is_empty() {
                return String::new();
            }
            if s.chars().all(|c| c.is_ascii_alphanumeric() || c.is_whitespace()) {
                // ASCII phrase: `"foo bar"` → `"foo bar"` (FTS keeps order).
                return format!("\"{}\"", s);
            }
            // For CJK phrases, emit each char as a token and wrap in quotes
            // so FTS5 matches them in order.
            let mut tokens: Vec<String> = Vec::new();
            let mut ascii_buf = String::new();
            for ch in s.chars() {
                if ch.is_ascii_alphanumeric() {
                    ascii_buf.push(ch.to_ascii_lowercase());
                } else {
                    if !ascii_buf.is_empty() {
                        tokens.push(std::mem::take(&mut ascii_buf));
                    }
                    if is_cjk(ch) {
                        tokens.push(ch.to_string());
                    }
                }
            }
            if !ascii_buf.is_empty() {
                tokens.push(ascii_buf);
            }
            if tokens.is_empty() {
                return String::new();
            }
            format!("\"{}\"", tokens.join(" "))
        }

        // FTS5 semantics require positive terms on the left of a NOT. If
        // the user writes `-X Y` we must emit `Y NOT X`, not `NOT X AND Y`.
        // We also need at least one positive term — a query that's purely
        // negations returns nothing by definition.
        let mut positives: Vec<(String, bool)> = Vec::new(); // (clause, or_flag)
        let mut negatives: Vec<String> = Vec::new();
        for term in terms {
            let clause = if term.is_quoted {
                quoted_to_clause(&term.text)
            } else {
                term_to_clause(&term.text)
            };
            if clause.is_empty() {
                continue;
            }
            if term.is_not {
                negatives.push(clause);
            } else {
                positives.push((clause, term.is_or_before));
            }
        }

        if positives.is_empty() {
            // Purely-negative queries are meaningless in FTS5. Rather than
            // throwing a syntax error we return None and let the caller
            // short-circuit to "no results".
            return None;
        }

        // Assemble positives with their AND/OR connectives.
        //
        // 相邻的 OR 项先合成一组，组间再 AND，多选项的组显式加括号。
        // FTS5 里 AND 比 OR 结合得紧，`A OR B AND C` 会被解析成
        // `A OR (B AND C)`，而线性扫描按 `(A OR B) AND C` 判定——不括起来
        // 两条路径对同一个查询的答案就不一样了。
        let mut groups: Vec<Vec<String>> = Vec::new();
        for (clause, or_flag) in positives {
            match groups.last_mut() {
                Some(group) if or_flag => group.push(clause),
                _ => groups.push(vec![clause]),
            }
        }
        let mut assembled = groups
            .into_iter()
            .map(|group| {
                if group.len() == 1 {
                    group.into_iter().next().unwrap()
                } else {
                    format!("({})", group.join(" OR "))
                }
            })
            .collect::<Vec<_>>()
            .join(" AND ");

        // Append any NOT clauses — one per negation, left-to-right.
        for neg in negatives {
            // Wrap the positive accumulator so the NOT doesn't bind to only
            // the last positive term under FTS5's precedence rules.
            assembled = format!("({}) NOT {}", assembled, neg);
        }

        Some(assembled)
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

    fn index_build_lock(&self) -> Arc<Mutex<()>> {
        let mut guard = INDEX_BUILD_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
        let map = guard.get_or_insert_with(HashMap::new);
        Arc::clone(
            map.entry(self.index_db_path.clone())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    /// 把数据集身份压成一行文本存进索引元数据。带上 `INDEX_VERSION` 和篇数，
    /// 任何一项对不上都必须重建。
    fn index_dataset_fingerprint(&self, story_count: usize) -> String {
        let fp = self.catalog_fingerprint();
        let files = fp
            .files
            .iter()
            .map(|(len, modified)| format!("{}:{}", len, modified))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "v{}|{}|{}|{}|{}",
            INDEX_VERSION, fp.commit, fp.fetched_at, files, story_count
        )
    }

    /// 索引是否已经对应当前数据集。除了比指纹，还要求两张表里实际的行数与
    /// 记录的总数一致——被截断或写坏的库不能被认成「最新」。
    fn index_current_totals(conn: &Connection, fingerprint: &str) -> Option<(usize, usize)> {
        let stored = Self::extract_meta_value(conn, META_DATASET_FINGERPRINT).ok()??;
        if stored != fingerprint {
            return None;
        }
        let recorded = |key: &str| -> Option<i64> {
            Self::extract_meta_value(conn, key)
                .ok()
                .flatten()
                .and_then(|v| v.parse::<i64>().ok())
        };
        let count = |sql: &str| -> Option<i64> { conn.query_row(sql, [], |row| row.get(0)).ok() };

        let stories = recorded(META_TOTAL_COUNT)?;
        let segments = recorded(META_SEGMENT_TOTAL)?;
        if stories <= 0
            || count("SELECT COUNT(*) FROM story_index")? != stories
            || count("SELECT COUNT(*) FROM story_segment_index")? != segments
        {
            return None;
        }
        Some((stories as usize, segments as usize))
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
        self.invalidate_catalog();

        // Auto-rebuild the FTS index so the next search is immediately fast
        // instead of silently falling back to linear scan (bug A5).
        // 真实刻度走 `index-progress`，这里只是宣布阶段切换：报 0/1 会让
        // 同步对话框先画一条 0% 的进度条，那个 0% 是编的。
        emit_progress(&app, "索引", 0, 0, "正在重建全文索引");
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
        let Some(current) = self.read_version() else {
            // 本地根本没有数据，提示用户下载。
            return Ok(true);
        };

        let local_commit = current.commit.trim();
        if local_commit.is_empty()
            || local_commit == "unknown"
            || local_commit.starts_with("manual-")
        {
            // 手动导入 / 版本未知的包没有可比较的 commit，无法判断新旧；
            // 报"有更新"会让用户每次启动都被催同步。
            return Ok(false);
        }

        let client = Self::create_http_client()?;
        match self.fetch_latest_commit(&client) {
            Ok(remote) => Ok(!local_commit.eq_ignore_ascii_case(remote.trim())),
            Err(err) => {
                // 网络/API 失败说明的是"查不到"，不是"有新版本"。
                eprintln!("[UPDATE] 检查更新失败，视为无更新: {}", err);
                Ok(false)
            }
        }
    }

    fn create_http_client() -> Result<Client, String> {
        Client::builder()
            .user_agent("arknights-story-reader")
            .connect_timeout(HTTP_CONNECT_TIMEOUT)
            .timeout(HTTP_OP_TIMEOUT)
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
        // 每读一个 8KB 块就 emit 一次，一个几百 MB 的包要发几万条事件，
        // 每条都要过一遍 JSON + IPC，事件本身比下载还贵。整数百分比（总长
        // 未知时按整 MB）变化才发一条，整场下载至多一两百条。
        let mut last_tick = usize::MAX;
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

            let downloaded_mb = downloaded as f64 / 1_048_576.0;
            if total_bytes > 0 {
                let percent = (downloaded as f64 / total_bytes as f64 * 100.0).min(100.0);
                let rounded = percent.round() as usize;
                if rounded != last_tick {
                    last_tick = rounded;
                    let total_mb = total_bytes as f64 / 1_048_576.0;
                    emit_progress(
                        app,
                        "下载",
                        rounded,
                        100,
                        format!("已下载 {:.1}/{:.1} MB", downloaded_mb, total_mb.max(0.1)),
                    );
                }
            } else {
                // 服务端没给 Content-Length，就没有百分比可言。以前这里一直
                // 报 0/100，进度条整场下载都钉在 0%；改成不确定态（total = 0），
                // 让前端只显示已下载的字节数。
                let whole_mb = downloaded >> 20;
                if whole_mb != last_tick {
                    last_tick = whole_mb;
                    emit_progress(app, "下载", 0, 0, format!("已下载 {:.1} MB", downloaded_mb));
                }
            }
        }
        zip_file
            .flush()
            .map_err(|e| format!("Failed to flush zip file: {}", e))?;

        emit_progress(app, "下载", 100, 100, "下载完成");
        self.extract_zip_at(&zip_path, parent_dir, Some(app))?;
        fs::remove_file(&zip_path).ok();

        Ok(())
    }

    fn extract_zip_at(
        &self,
        zip_path: &Path,
        parent_dir: &Path,
        app: Option<&AppHandle>,
    ) -> Result<(), String> {
        emit_progress_opt(app, "解压", 0, 100, "正在解压数据");
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
        // 数据包里有几万个条目，逐条 emit 会把事件总线灌满（同下载循环）；
        // 整数百分比变了才发一条。
        let mut last_percent = usize::MAX;
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
            let rounded = percent.round() as usize;
            if rounded != last_percent {
                last_percent = rounded;
                emit_progress_opt(
                    app,
                    "解压",
                    rounded,
                    100,
                    format!("解压 {}/{} ({:.1}%)", i + 1, total_entries, percent),
                );
            }
        }

        emit_progress_opt(app, "解压", 100, 100, "解压完成");

        let extracted_root = fs::read_dir(&extract_root)
            .map_err(|e| format!("Failed to read extracted directory: {}", e))?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|path| path.is_dir())
            .ok_or_else(|| {
                fs::remove_dir_all(&extract_root).ok();
                "解压后的文件结构不正确".to_string()
            })?;

        // 先验收再动旧数据：如果这个包里没有 story_review_table.json，整个
        // 应用就是空的。此时必须保留已有 data_dir，让用户继续用旧数据。
        // 空文件同样算校验失败——半截下载解出来的壳子比旧数据更没用。
        if !Self::holds_valid_dataset(&extracted_root) {
            fs::remove_dir_all(&extract_root).ok();
            return Err(format!(
                "ZIP 校验失败：缺少或为空 {}，已保留原有数据",
                REVIEW_TABLE_REL
            ));
        }

        // 阅读器只需要 story / excel 数据；关卡、战斗、美术等目录加起来
        // 是数据集的大头，移动前先剪掉，省磁盘也省一次拷贝。
        Self::prune_unused_dirs(&extracted_root);

        self.swap_in_extracted(&extracted_root)?;

        fs::remove_dir_all(&extract_root).ok();
        // 数据目录已经整个换掉，缓存的剧情目录立刻作废。
        self.invalidate_catalog();
        Ok(())
    }

    /// 旧数据在换入期间的暂存目录（`<data_dir>_old`）。上一次换入若在
    /// 「挪开旧目录」和「删掉暂存」之间崩溃会留下残骸：能清就清掉复用
    /// 固定名字；清不掉就退化成带时间戳的名字，绝不往已有目录上改名。
    fn old_data_aside_path(&self) -> PathBuf {
        let mut name = self
            .data_dir
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_else(|| std::ffi::OsString::from("ArknightsGameData"));
        name.push("_old");
        let fixed = self.data_dir.with_file_name(&name);
        if !fixed.exists() || fs::remove_dir_all(&fixed).is_ok() {
            return fixed;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        name.push(format!("_{}", nanos));
        self.data_dir.with_file_name(name)
    }

    /// `extract_zip_at` 的验收标准：非空 `story_review_table.json` 才算一份
    /// 撑得起应用的数据集。换入验收和崩溃恢复用同一把尺子。
    fn holds_valid_dataset(dir: &Path) -> bool {
        fs::metadata(dir.join(REVIEW_TABLE_REL))
            .map(|meta| meta.is_file() && meta.len() > 0)
            .unwrap_or(false)
    }

    /// `swap_in_extracted` 若恰好在「旧目录挪开」和「新目录落位」两次改名
    /// 之间崩溃/断电，`data_dir` 会消失，完整的旧数据却还躺在暂存目录里
    /// （固定的 `<data_dir>_old`，或它清不掉时退化出的
    /// `<data_dir>_old_<纳秒>`，见 `old_data_aside_path`）。启动时把这份
    /// 残骸改名接回 `data_dir`，数据不会因为一次断电就「消失」。
    ///
    /// 只认里面有非空 `story_review_table.json` 的暂存目录；半截壳子恢复
    /// 回去也撑不起应用，一概不碰，留给下一次换入开场清理。同时存在多个
    /// 候选时取时间戳最大的：带时间戳的名字只在固定名残骸清不掉时才会
    /// 启用，必然比固定名新。`data_dir` 尚在时什么都不做——成功换入后
    /// 清理失败留下的 `_old` 是上一份数据，抢着恢复反而会顶掉新数据。
    fn restore_data_dir_from_aside(&self) {
        if self.data_dir.exists() {
            return;
        }
        let Some(parent) = self.data_dir.parent() else {
            return;
        };
        let Some(dir_name) = self.data_dir.file_name().and_then(|n| n.to_str()) else {
            return;
        };
        let fixed_name = format!("{}_old", dir_name);

        // (时间戳, 路径)。固定名没有时间戳，记 0，天然排在最旧。
        let mut candidates: Vec<(u128, PathBuf)> = Vec::new();
        let fixed = parent.join(&fixed_name);
        if Self::holds_valid_dataset(&fixed) {
            candidates.push((0, fixed));
        }
        if let Ok(entries) = fs::read_dir(parent) {
            let stamped_prefix = format!("{}_", fixed_name);
            for entry in entries.flatten() {
                let file_name = entry.file_name();
                let Some(name) = file_name.to_str() else {
                    continue;
                };
                let Some(stamp) = name.strip_prefix(&stamped_prefix) else {
                    continue;
                };
                let Ok(stamp) = stamp.parse::<u128>() else {
                    continue;
                };
                let path = entry.path();
                if Self::holds_valid_dataset(&path) {
                    candidates.push((stamp, path));
                }
            }
        }
        let Some((_, aside)) = candidates.into_iter().max_by_key(|(stamp, _)| *stamp) else {
            return;
        };

        match fs::rename(&aside, &self.data_dir) {
            Ok(()) => {
                eprintln!("[RECOVER] 上次数据换入中断，已从 {:?} 恢复数据目录", aside);
            }
            Err(err) => {
                // 恢复失败不致命：数据仍完整躺在暂存目录里，下次启动重试。
                eprintln!(
                    "[RECOVER] 发现换入中断残留 {:?}，但恢复失败（数据仍完整保留）: {}",
                    aside, err
                );
            }
        }
    }

    /// 把验收完毕的新数据树换到 `data_dir`。
    ///
    /// 旧实现是「删旧 → 改名新」：整树删除耗时不短，删除开始到改名完成
    /// 之间崩溃/断电，旧数据已经没了、新数据还没落位，两头落空。现在：
    /// 1. 旧目录整体改名挪到旁边（一次系统调用，不碰内容）；
    /// 2. 新目录改名进 `data_dir`（跨设备改名失败时退回整树拷贝）；
    /// 3. 新数据确认落位后才删除旧目录。
    /// 第 2 步失败会把旧目录改回原位。即便恰好在两次改名之间崩溃，旧数
    /// 据也还完整躺在暂存目录里，不会凭空蒸发。
    fn swap_in_extracted(&self, extracted_root: &Path) -> Result<(), String> {
        let old_aside = if self.data_dir.exists() {
            let aside = self.old_data_aside_path();
            match fs::rename(&self.data_dir, &aside) {
                Ok(()) => Some(aside),
                Err(err) => {
                    // 挪不开（Windows 上目录被占用等）只能退回原地删除。
                    // 这条退化路径没有崩溃保护，但也不比旧行为更差。
                    eprintln!("[SYNC] 旧数据目录改名失败，退回原地替换: {}", err);
                    fs::remove_dir_all(&self.data_dir)
                        .map_err(|e| format!("Failed to remove old data: {}", e))?;
                    None
                }
            }
        } else {
            None
        };

        let landed = match fs::rename(extracted_root, &self.data_dir) {
            Ok(()) => Ok(()),
            // 应用数据目录和解压目录不在同一设备时 rename 不可用。
            Err(_) => copy_dir_all(extracted_root, &self.data_dir).map(|_| {
                fs::remove_dir_all(extracted_root).ok();
            }),
        };

        match landed {
            Ok(()) => {
                if let Some(aside) = old_aside {
                    // 删不掉只是暂时占点磁盘，留给下一次换入开场清理
                    //（见 `old_data_aside_path`），不能算安装失败。
                    if let Err(err) = fs::remove_dir_all(&aside) {
                        eprintln!("[SYNC] 清理旧数据暂存 {:?} 失败（忽略）: {}", aside, err);
                    }
                }
                Ok(())
            }
            Err(err) => {
                if let Some(aside) = old_aside {
                    // 清掉可能的半截拷贝，再把旧数据改回原位。
                    if self.data_dir.exists() {
                        fs::remove_dir_all(&self.data_dir).ok();
                    }
                    if let Err(restore_err) = fs::rename(&aside, &self.data_dir) {
                        return Err(format!(
                            "{}；回滚旧数据也失败（数据仍完整保留在 {:?}）: {}",
                            err, aside, restore_err
                        ));
                    }
                }
                Err(err)
            }
        }
    }

    /// 删除阅读器用不到的大目录（存在才删，失败只记日志）。
    fn prune_unused_dirs(root: &Path) {
        const UNUSED: &[&str] = &[
            "zh_CN/gamedata/levels",
            "zh_CN/gamedata/bakemuzzledata",
            "zh_CN/gamedata/battle",
            "zh_CN/gamedata/building",
            "zh_CN/gamedata/art",
            "zh_CN/gamedata/[uc]lua",
            "zh_CN/gamedata/levelscripts",
            "zh_CN/gamedata/story/[uc]lua",
            "zh_CN/gamedata/story/levelscripts",
        ];
        for rel in UNUSED {
            let path = root.join(rel);
            if !path.is_dir() {
                continue;
            }
            if let Err(err) = fs::remove_dir_all(&path) {
                eprintln!("[SYNC] 剪枝 {:?} 失败（忽略）: {}", path, err);
            }
        }
    }

    /// 解压手动导入的临时 ZIP，无论成败都删掉临时文件：这个 ZIP 和数据集
    /// 一个量级，解压失败后留着只会白占几百 MB 磁盘，下次导入也会原样
    /// 重写一份。
    fn extract_import_zip(
        &self,
        temp_path: &Path,
        parent_dir: &Path,
        app: Option<&AppHandle>,
    ) -> Result<(), String> {
        let extracted = self.extract_zip_at(temp_path, parent_dir, app);
        fs::remove_file(temp_path).ok();
        extracted
    }

    fn finalize_manual_import(&self, temp_path: &Path, app: &AppHandle) -> Result<(), String> {
        let parent_dir = self
            .data_dir
            .parent()
            .ok_or_else(|| "Invalid data directory".to_string())?;

        emit_progress(app, "导入", 40, 100, "正在解压 ZIP 文件");
        self.extract_import_zip(temp_path, parent_dir, Some(app))?;

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
        self.invalidate_catalog();

        // Auto-rebuild the FTS index (bug A5, same as sync_data).
        emit_progress(app, "索引", 0, 0, "正在重建全文索引");
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
    #[allow(dead_code)]
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
    ///
    /// 由 `main_groups` 现拼，不再在目录里单独存一份主线副本。顺带把顺序修
    /// 正成「按章节、章节内按 storySort」——原来是把所有主线摊平后全局按
    /// storySort 排，而 storySort 是组内序号，结果是各章节的第 1 篇挤在一起。
    pub fn get_story_categories(&self) -> Result<Vec<StoryCategory>, String> {
        let catalog = self.catalog()?;
        let stories: Vec<StoryEntry> = catalog
            .main_groups
            .iter()
            .flat_map(|(_, group)| group.iter().cloned())
            .collect();
        if stories.is_empty() {
            return Ok(Vec::new());
        }
        Ok(vec![StoryCategory {
            id: "mainline".to_string(),
            name: "主线剧情".to_string(),
            category_type: "chapter".to_string(),
            stories,
        }])
    }

    /// 根据 entryType 解析剧情
    fn parse_stories_by_entry_type(
        data: &HashMap<String, Value>,
        entry_type: &str,
    ) -> Vec<StoryEntry> {
        let mut stories = Vec::new();

        for (_id, value) in data.iter() {
            if let Some(et) = value.get("entryType").and_then(|v| v.as_str()) {
                if et == entry_type {
                    stories.extend(Self::parse_group_entries(value));
                }
            }
        }

        stories.sort_by_key(|s| s.story_sort);
        stories
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
    #[allow(dead_code)]
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

        // 同一份索引同时只允许一次重建。同步/导入完成后后台线程会自动重建，
        // 而前端的 `useAutoIndex`（以及设置页的手动按钮）可能同时也发起一次；
        // 两个事务同时写同一张 FTS 表只会互相 SQLITE_BUSY。串行化之后，
        // 后来的那次会发现指纹已经对上，直接返回。
        let build_lock = self.index_build_lock();
        let _build_guard = build_lock.lock().unwrap_or_else(|e| e.into_inner());

        // 拿到锁后先给数据集身份拍一张快照，提交前再对一次（见循环之后）。
        // 锁串行化的是「多个重建」，挡不住重建进行到一半时同步/导入把
        // data_dir 整个换掉——那样本次读到的就是新旧混合的文件。
        let dataset_probe = self.catalog_fingerprint();
        let catalog = self.catalog()?;
        let fingerprint = self.index_dataset_fingerprint(catalog.stories.len());

        let mut conn = self.open_index_connection()?;
        Self::init_index_tables(&conn)?;

        if let Some((stories, segments)) = Self::index_current_totals(&conn, &fingerprint) {
            emit(
                "完成",
                stories,
                stories,
                &format!("索引已是最新（{} 篇 / {} 段）", stories, segments),
            );
            return Ok(());
        }

        #[cfg(test)]
        {
            let mut guard = INDEX_BUILD_LOG.lock().unwrap_or_else(|e| e.into_inner());
            *guard
                .get_or_insert_with(HashMap::new)
                .entry(self.index_db_path.clone())
                .or_insert(0) += 1;
        }

        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start index transaction: {}", e))?;

        tx.execute("DELETE FROM story_index", [])
            .map_err(|e| format!("Failed to clear story index: {}", e))?;
        tx.execute("DELETE FROM story_segment_index", [])
            .map_err(|e| format!("Failed to clear story segment index: {}", e))?;

        let indexed_stories = &catalog.stories;
        let mut story_insert_stmt = tx
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
        let mut segment_insert_stmt = tx
            .prepare(
                "
            INSERT INTO story_segment_index (
                story_id,
                segment_index,
                segment_type,
                character_name,
                tokenized_text,
                raw_text
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ",
            )
            .map_err(|e| format!("Failed to prepare segment index insert: {}", e))?;

        let mut total = 0usize;
        let mut segment_total = 0usize;

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
            // 原文已经解析完了，`combined_raw` / `tokenized` 都不小；
            // 提前放掉，别让同一篇剧情在内存里同时躺四五份。
            drop(raw_text);
            // Post-process segments the same way the frontend reader does so
            // that the segment indices we store match what the UI will scroll
            // to. Specifically: drop empty segments and merge consecutive
            // same-speaker dialogue.
            let processed = Self::post_process_segments_for_index(&parsed.segments);
            drop(parsed);
            let combined_raw = Self::searchable_text(story_name, &processed);

            let tokenized = Self::build_tokenized_content(&combined_raw);
            if tokenized.trim().is_empty() {
                continue;
            }

            story_insert_stmt
                .execute(params![
                    story_id,
                    story_name,
                    &*indexed.category_label,
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

            // Per-segment insertion: only meaningful textual segments are
            // indexed. Header/Decision are useful for navigation so we still
            // index their text where applicable.
            for (seg_idx, segment) in processed.iter().enumerate() {
                // 段落文本一律借用；只有 Decision 需要现拼一份。之前这里每段
                // 都 `clone()`，相当于把整部语料在重建过程中又复制了一遍。
                let (seg_type, character_name, raw_text): (&str, Option<&str>, Cow<'_, str>) =
                    match segment {
                        StorySegment::Dialogue { character_name, text, .. } => (
                            "dialogue",
                            Some(character_name.as_str()),
                            Cow::Borrowed(text.as_str()),
                        ),
                        StorySegment::Narration { text } => {
                            ("narration", None, Cow::Borrowed(text.as_str()))
                        }
                        StorySegment::System { speaker, text } => {
                            ("system", speaker.as_deref(), Cow::Borrowed(text.as_str()))
                        }
                        StorySegment::Subtitle { text, .. } => {
                            ("subtitle", None, Cow::Borrowed(text.as_str()))
                        }
                        StorySegment::Sticker { text, .. } => {
                            ("sticker", None, Cow::Borrowed(text.as_str()))
                        }
                        StorySegment::Header { title } => {
                            ("header", None, Cow::Borrowed(title.as_str()))
                        }
                        StorySegment::Decision { options, .. } => {
                            ("decision", None, Cow::Owned(options.join("\n")))
                        }
                        StorySegment::Image { caption, .. } => {
                            // 插画段 caption 如有文字可索引；否则跳过。
                            ("image", None, Cow::Borrowed(caption.as_deref().unwrap_or("")))
                        }
                        StorySegment::Music { .. } => ("music", None, Cow::Borrowed("")),
                    };
                if raw_text.trim().is_empty() {
                    continue;
                }
                let seg_tokenized = Self::build_tokenized_content(&raw_text);
                if seg_tokenized.trim().is_empty() {
                    continue;
                }
                let character_norm = character_name
                    .map(|c| Self::build_tokenized_content(c))
                    .unwrap_or_default();
                segment_insert_stmt
                    .execute(params![
                        story_id,
                        seg_idx as i64,
                        seg_type,
                        character_norm,
                        seg_tokenized,
                        raw_text.as_ref(),
                    ])
                    .map_err(|e| format!("Failed to insert segment into index: {}", e))?;
                segment_total += 1;
            }

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

        drop(story_insert_stmt);
        drop(segment_insert_stmt);

        // 提交前复核：构建期间数据集被同步/导入换掉的话，上面读到的是新旧
        // 混合的内容，而此刻的磁盘指纹已经是新数据集的。若照常提交，这份
        // 杂交索引会被盖上新指纹，刚结束的那次同步随后自动发起的重建（在
        // `INDEX_BUILD_LOCKS` 上排队）一看指纹相符就直接跳过，坏索引从此
        // 常驻。回滚本次事务，把重建让给排在后面的那一次。
        if self.catalog_fingerprint() != dataset_probe {
            return Err(
                "数据集在索引重建期间被替换，本次结果已回滚，稍后会自动重建".to_string(),
            );
        }

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        for (key, value) in [
            ("last_built_at", timestamp.to_string()),
            (META_TOTAL_COUNT, total.to_string()),
            (META_SEGMENT_TOTAL, segment_total.to_string()),
            // 最后写指纹：中途失败时事务回滚，下一次照样会完整重建。
            (META_DATASET_FINGERPRINT, fingerprint),
        ] {
            tx.execute(
                "
            INSERT INTO story_index_meta (key, value)
            VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        ",
                params![key, value],
            )
            .map_err(|e| format!("Failed to update index metadata {}: {}", key, e))?;
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit story index rebuild: {}", e))?;

        emit(
            "完成",
            total,
            total,
            &format!("已索引 {} 篇 / {} 段", total, segment_total),
        );

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

    /// 线性扫描：索引不可用时的兜底。`on_progress(done, total)` 在开扫之前
    /// 会先被调用一次 `(0, total)`，之后每处理完一篇调用一次。
    ///
    /// 这是唯一一份扫描实现——`search_stories_fallback` 与
    /// `search_stories_with_progress` 曾经各抄了一份，两边的判定条件很容易
    /// 慢慢长歪。
    fn scan_stories(
        &self,
        query: &str,
        mut on_progress: impl FnMut(usize, usize),
    ) -> Result<Vec<SearchResult>, String> {
        let catalog = self.catalog()?;
        let stories = &catalog.stories;
        let total = stories.len();
        on_progress(0, total);

        let terms = split_query_terms(query);
        if terms.positive.is_empty() {
            // Purely-negative (or empty) queries have no meaningful answer.
            return Ok(Vec::new());
        }

        let mut results = Vec::new();
        for (idx, indexed) in stories.iter().enumerate() {
            let story = &indexed.story;
            let story_name_norm = normalize_for_fuzzy(&story.story_name);
            let code_norm = story
                .story_code
                .as_ref()
                .map(|s| normalize_for_fuzzy(s))
                .unwrap_or_default();
            let title_hits =
                terms.positives_match(&[story_name_norm.as_str(), code_norm.as_str()]);

            // Fast path: title/code hit and nothing to exclude. With NOT terms
            // in play we still have to read the body, since an exclusion may
            // only appear there.
            let hit = if title_hits && terms.negative.is_empty() {
                Some(story.story_name.clone())
            } else {
                // 扫的是「标题 + 解析后的正文」，也就是索引里 `raw_content`
                // 的同一份文本。直接扫原始脚本的话，`[name=...]`、素材 token
                // 之类的指令文字只在这条路径上能被搜到，索引建好之后同一个
                // 查询就突然搜不到了。
                self.story_searchable_text(&story.story_name, &story.story_txt)
                    .and_then(|content| {
                        let content_norm = normalize_for_fuzzy(&content);
                        let haystacks = [content_norm.as_str(), code_norm.as_str()];
                        if terms.excluded_by(&haystacks) {
                            return None;
                        }
                        if !title_hits && !terms.positives_match(&haystacks) {
                            return None;
                        }
                        Some(if title_hits {
                            story.story_name.clone()
                        } else {
                            self.preview_for(&content, terms.primary())
                        })
                    })
            };

            if let Some(matched_text) = hit {
                results.push(SearchResult {
                    story_id: story.story_id.clone(),
                    story_name: story.story_name.clone(),
                    matched_text,
                    // 只有真的命中才付这次 `String` 分配的钱。
                    category: indexed.category_label.to_string(),
                });
            }

            on_progress(idx + 1, total);
            if results.len() >= SEARCH_RESULT_LIMIT {
                break;
            }
        }

        Ok(results)
    }

    /// 命中片段：先按整词定位，不行再退回单个原子，最后给一段开头预览。
    /// 空字符串对用户毫无意义，任何情况下都要给点上下文。
    fn preview_for(&self, content: &str, term: Option<&Term>) -> String {
        if let Some(term) = term {
            let snippet = self.extract_context_any(content, term.snippet_probes());
            if !snippet.trim().is_empty() {
                return snippet;
            }
        }
        // 兜底预览只需要开头这点字，别为了截 120 个字符把整篇正文压平两遍。
        let head: String = content.chars().take(400).collect();
        Self::clip_preview(&head, 120)
    }

    fn search_stories_fallback(&self, query: &str) -> Result<Vec<SearchResult>, String> {
        self.scan_stories(query, |_, _| {})
    }

    /// 搜索剧情（混合：索引优先 + 线性扫描补全，防止遗漏）
    ///
    /// When the FTS index exists and returns a non-empty result set (or an
    /// empty set from a well-formed query against an up-to-date corpus), we
    /// trust it and skip the O(N*segments) linear scan. The scan only runs
    /// as a fallback when the index is missing, corrupt, or returned an
    /// error — otherwise a single query over 1900+ stories can easily take
    /// 30s+ on lower-end devices.
    pub fn search_stories(&self, query: &str) -> Result<Vec<SearchResult>, String> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        match self.search_stories_with_index(trimmed) {
            // Index returned authoritative results — don't waste time on
            // linear scan. Char-level FTS5 is a superset of plain contains()
            // matching at this point.
            Ok(Some(results)) => Ok(results),
            // Index not ready (never built, was cleared, or empty table).
            // Fall through to the slower scanner so the user can still get
            // *something* on first launch. The scanner caps at
            // SEARCH_RESULT_LIMIT and doesn't attempt to enumerate every
            // story — practical budget is single-digit seconds on a typical
            // machine.
            Ok(None) => self.search_stories_fallback(trimmed),
            Err(err) => {
                eprintln!(
                    "[INDEX] Failed to search using index ({}), fallback to linear scan",
                    err
                );
                self.search_stories_fallback(trimmed)
            }
        }
    }

    /// Extended search: returns total match count (before truncation) and per-
    /// category facet counts so the frontend can offer filter chips and a
    /// "N 条已显示 / M 条匹配" hint. The underlying logic mirrors
    /// `search_stories` (FTS + linear scan, deduped), but it also runs a
    /// separate `COUNT(*)` on the FTS side for accurate totals.
    pub fn search_stories_ex(&self, query: &str) -> Result<SearchResultsPage, String> {
        self.search_stories_ex_inner(query, None)
    }

    /// 与 `search_stories_ex` 相同，但沿途 emit `search-progress`，
    /// 让前端在回退线性扫描（可能几秒）时不至于是一片空白。
    pub fn search_stories_ex_with_progress(
        &self,
        app: &AppHandle,
        query: &str,
    ) -> Result<SearchResultsPage, String> {
        self.search_stories_ex_inner(query, Some(app))
    }

    fn search_stories_ex_inner(
        &self,
        query: &str,
        app: Option<&AppHandle>,
    ) -> Result<SearchResultsPage, String> {
        let progress = |phase: &str, cur: usize, total: usize, msg: String| {
            if let Some(app) = app {
                emit_search_progress(app, phase, cur, total, msg);
            }
        };

        let trimmed = query.trim();
        if trimmed.is_empty() {
            progress("完成", 1, 1, "查询为空".to_string());
            return Ok(SearchResultsPage {
                results: Vec::new(),
                total_matched: 0,
                truncated: false,
                facets: Default::default(),
            });
        }

        // `total = 0` 是与前端约定的「不确定态」：还不知道要走索引还是扫全库，
        // 报一个 0/3 只是编出来的百分比。真实分母由线性扫描那一步给出。
        progress("检索", 0, 0, format!("搜索「{}」", trimmed));
        let results = self.search_stories_emitting(app, trimmed)?;

        // Compute total via FTS (best effort — if the index is unavailable we
        // fall back to `results.len()` which is at least a lower bound).
        progress("统计", 0, 0, format!("命中 {} 篇，正在统计", results.len()));
        let total_matched = self
            .count_fts_matches(trimmed)
            .unwrap_or_else(|_| results.len());
        let total_matched = total_matched.max(results.len());
        progress("完成", 1, 1, format!("共 {} 条匹配", total_matched));

        // Build facets from the returned subset. Categories are formatted as
        // `<Type> | <Specific Name>` (see `format_category_label`); aggregating
        // by full string produces one chip per chapter which is unusable.
        // Instead we bucket by the type prefix so users get a handful of broad
        // filters (主线 / 活动 / 支线 / 肉鸽 / 干员密录).
        let mut facets: std::collections::BTreeMap<String, usize> = Default::default();
        for r in &results {
            let key = r
                .category
                .split(" | ")
                .next()
                .unwrap_or(&r.category)
                .trim()
                .to_string();
            *facets.entry(key).or_insert(0) += 1;
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

    /// Segment-level search: returns precise `(story_id, segment_index)`
    /// hits ordered by bm25 so the frontend can jump directly to the matching
    /// paragraph without running the fuzzy `findFocusSegmentIndex` fallback.
    ///
    /// When the segment index table hasn't been built (pre-v4 database or
    /// first-run before sync completes), this returns an empty page and the
    /// caller should fall back to `search_stories_ex`.
    pub fn search_segments(&self, query: &str) -> Result<SegmentSearchPage, String> {
        self.search_segments_inner(query, None)
    }

    /// 与 `search_segments` 相同，额外 emit `search-progress`。
    pub fn search_segments_with_progress(
        &self,
        app: &AppHandle,
        query: &str,
    ) -> Result<SegmentSearchPage, String> {
        self.search_segments_inner(query, Some(app))
    }

    fn search_segments_inner(
        &self,
        query: &str,
        app: Option<&AppHandle>,
    ) -> Result<SegmentSearchPage, String> {
        let progress = |phase: &str, cur: usize, total: usize, msg: String| {
            if let Some(app) = app {
                emit_search_progress(app, phase, cur, total, msg);
            }
        };

        let trimmed = query.trim();
        if trimmed.is_empty() {
            progress("完成", 1, 1, "查询为空".to_string());
            return Ok(SegmentSearchPage {
                hits: Vec::new(),
                total_matched: 0,
                truncated: false,
            });
        }

        // 段落检索只有一步（一次 FTS 查询），中途没有可报的真实刻度。
        // `total = 0` 让前端转 spinner，而不是画一条永远停在 0% 的进度条。
        progress("段落检索", 0, 0, format!("搜索「{}」", trimmed));

        let Some(conn) = self.try_open_index_connection()? else {
            progress("完成", 1, 1, "段落索引尚未建立".to_string());
            return Ok(SegmentSearchPage {
                hits: Vec::new(),
                total_matched: 0,
                truncated: false,
            });
        };
        Self::init_index_tables(&conn)?;

        // Bail out if the segment table exists but is empty (e.g. after
        // schema bump while rebuild is still running in the background).
        let seg_total: i64 = conn
            .query_row("SELECT COUNT(*) FROM story_segment_index", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);
        if seg_total == 0 {
            progress("完成", 1, 1, "段落索引为空".to_string());
            return Ok(SegmentSearchPage {
                hits: Vec::new(),
                total_matched: 0,
                truncated: false,
            });
        }

        let Some(fts_query) = Self::build_fts_query_advanced(trimmed) else {
            progress("完成", 1, 1, "查询没有可用的正向词".to_string());
            return Ok(SegmentSearchPage {
                hits: Vec::new(),
                total_matched: 0,
                truncated: false,
            });
        };

        // bm25 column weights: story_id(UNINDEXED)=0, segment_index(UNINDEXED)=0,
        // segment_type(UNINDEXED)=0, character_name=6, tokenized_text=1,
        // raw_text(UNINDEXED)=0. Boost character name matches so searching an
        // operator floats dialogue hits featuring that operator to the top.
        let query_sql = format!(
            "
            SELECT s.story_id,
                   s.segment_index,
                   s.segment_type,
                   s.character_name,
                   s.raw_text,
                   snippet(story_segment_index, 4, '', '', '...', 16) AS snip
            FROM story_segment_index AS s
            WHERE story_segment_index MATCH ?1
            ORDER BY bm25(story_segment_index, 0.0, 0.0, 0.0, 6.0, 1.0, 0.0)
            LIMIT {}
            ",
            SEARCH_RESULT_LIMIT
        );

        let mut stmt = match conn.prepare(&query_sql) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("[SEG-INDEX] prepare failed: {}", err);
                progress("完成", 1, 1, "段落索引不可用".to_string());
                return Ok(SegmentSearchPage {
                    hits: Vec::new(),
                    total_matched: 0,
                    truncated: false,
                });
            }
        };

        // 显示标签走目录（`story_id` → 剧情名 / 分类），本身就是缓存好的。
        let catalog = self.collect_story_labels();
        let labels = catalog.as_deref();

        let rows = match stmt.query_map(params![fts_query], |row| {
            let story_id: String = row.get(0)?;
            let segment_index: i64 = row.get(1)?;
            let segment_type: String = row.get(2)?;
            let character_name: String = row.get(3).unwrap_or_default();
            let raw_text: String = row.get(4).unwrap_or_default();
            let snip: String = row.get(5).unwrap_or_default();
            Ok((story_id, segment_index, segment_type, character_name, raw_text, snip))
        }) {
            Ok(r) => r,
            Err(err) => {
                eprintln!("[SEG-INDEX] query failed for '{}': {}", fts_query, err);
                progress("完成", 1, 1, "段落检索失败".to_string());
                return Ok(SegmentSearchPage {
                    hits: Vec::new(),
                    total_matched: 0,
                    truncated: false,
                });
            }
        };

        let context_probe = normalize_for_fuzzy(trimmed);
        let mut hits: Vec<SegmentHit> = Vec::new();
        let mut seen: std::collections::HashSet<(String, usize)> = Default::default();
        for row in rows {
            let Ok((story_id, segment_index, segment_type, character_norm, raw_text, _snip)) = row
            else {
                continue;
            };
            // Did the query actually hit the segment body / speaker? Used
            // for the UI's "按说话人命中" badge. "mixed" is our honest
            // fallback when the char-level tokens matched but neither the
            // body nor the speaker contain the full probe verbatim — in
            // that case we show no badge rather than falsely accusing one
            // column of being the culprit.
            let body_norm = normalize_for_fuzzy(&raw_text);
            let speaker_norm = normalize_for_fuzzy(&character_norm);
            let body_hit = !context_probe.is_empty() && body_norm.contains(&context_probe);
            let speaker_hit = !context_probe.is_empty() && speaker_norm.contains(&context_probe);
            let match_target = if body_hit {
                "body"
            } else if speaker_hit {
                "speaker"
            } else {
                "mixed"
            };

            // Build the preview. When the body actually contains the term we
            // center the preview around the match; otherwise we show the
            // whole segment (trimmed) so the user gets meaningful context
            // even for short "好 / 嗯 / mon3tr" segments.
            let matched_text = if body_hit {
                let extracted = self.extract_context(&raw_text, &context_probe);
                if extracted.trim().is_empty() {
                    Self::clip_preview(&raw_text, 240)
                } else {
                    extracted
                }
            } else {
                Self::clip_preview(&raw_text, 240)
            };
            let (story_name, category) = labels
                .and_then(|c| c.label_for(&story_id))
                .map(|(name, label)| (name.to_string(), label.to_string()))
                .unwrap_or_else(|| (story_id.clone(), String::new()));
            let character_name = if character_norm.trim().is_empty() {
                None
            } else {
                // The stored value is the tokenized (space-separated) form;
                // strip spaces for display since the UI shows short names.
                Some(character_norm.split_whitespace().collect::<String>())
            };
            let seg_idx = segment_index.max(0) as usize;
            seen.insert((story_id.clone(), seg_idx));
            hits.push(SegmentHit {
                story_id,
                story_name,
                category,
                segment_index: seg_idx,
                segment_type,
                character_name,
                matched_text,
                match_target: match_target.to_string(),
            });
        }

        // Merge story-name / story-code hits from the story-level index so
        // exact title lookups like `大地惊雷` still surface as a clickable
        // result even though the title itself isn't stored as a segment.
        // Each such hit is presented as a pseudo-"header" segment at index 0
        // so the reader lands on the beginning of the story when clicked.
        if let Ok(story_rows) = Self::story_level_title_hits(&conn, &fts_query, trimmed, labels) {
            let remaining = SEARCH_RESULT_LIMIT.saturating_sub(hits.len());
            for hit in story_rows.into_iter().take(remaining) {
                let key = (hit.story_id.clone(), hit.segment_index);
                if !seen.contains(&key) {
                    seen.insert(key);
                    hits.push(hit);
                }
            }
        }

        // Skip the COUNT(*) round-trip when we clearly aren't truncated —
        // `rows.len() < LIMIT` implies every matching row is in `hits`.
        // Only when the LIMIT kicked in do we need the authoritative total
        // to drive the "已显示 X / Y" hint in the UI.
        let total_matched = if hits.len() >= SEARCH_RESULT_LIMIT {
            let total: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM story_segment_index WHERE story_segment_index MATCH ?1",
                    params![fts_query.clone()],
                    |row| row.get(0),
                )
                .unwrap_or(hits.len() as i64);
            hits.len().max(total.max(0) as usize)
        } else {
            hits.len()
        };

        progress("完成", 2, 2, format!("命中 {} 段", total_matched));

        Ok(SegmentSearchPage {
            hits,
            total_matched,
            truncated: total_matched > SEARCH_RESULT_LIMIT,
        })
    }

    /// 给段落命中贴显示标签用的目录（`StoryCatalog::label_for`）。走的是
    /// memoized 目录，不会重新解析整张 review 表。标签只是装饰，数据集缺失
    /// 时降级成没有标签，而不是没有结果。
    fn collect_story_labels(&self) -> Option<Arc<StoryCatalog>> {
        match self.catalog() {
            Ok(catalog) => Some(catalog),
            Err(err) => {
                eprintln!("[SEG-INDEX] 无法加载剧情标签: {}", err);
                None
            }
        }
    }

    /// Produce segment-style hits derived from the story-level index, used
    /// so that searches for story titles / codes still surface relevant
    /// entries even when the actual title text doesn't appear in any
    /// segment body. Each pseudo-hit lands on segment index 0 (the start of
    /// the story). `fts_query` is the already-compiled FTS query string.
    ///
    /// We deliberately do NOT use FTS5 `{col}:` scoping here — the
    /// `story_name` column is stored raw (no pre-tokenization), so unicode61
    /// only produces a single-CJK-run token per title. Scoping-by-column
    /// would therefore fail for any multi-word title query. Instead we rely
    /// on the existing bm25 column weighting (story_name × 10) to push
    /// genuine title matches to the top, and then post-filter the results
    /// so only rows whose title or code actually contains the user's query
    /// survive. This catches exact title lookups like `大地惊雷` even when
    /// no body segment matches.
    ///
    /// 复用调用方已经打开的连接：段落检索每次都新开一条 SQLite 连接（还要
    /// 重跑一遍 WAL pragma）纯属浪费。
    fn story_level_title_hits(
        conn: &Connection,
        fts_query: &str,
        query_raw: &str,
        labels: Option<&StoryCatalog>,
    ) -> Result<Vec<SegmentHit>, String> {
        let sql = "
            SELECT story_id, story_name, category, story_code
            FROM story_index
            WHERE story_index MATCH ?1
            ORDER BY bm25(story_index, 0.0, 10.0, 0.0, 1.0, 5.0, 0.0)
            LIMIT 50
        ";
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(_) => return Ok(Vec::new()),
        };
        let rows = match stmt.query_map(params![fts_query], |row| {
            let story_id: String = row.get(0)?;
            let story_name: String = row.get(1)?;
            let category: String = row.get(2)?;
            let story_code: String = row.get(3).unwrap_or_default();
            Ok((story_id, story_name, category, story_code))
        }) {
            Ok(r) => r,
            Err(_) => return Ok(Vec::new()),
        };

        // Post-filter: the row's title or code must contain the user's
        // query under fuzzy normalization (NFKC + lower + punct-strip).
        // This weeds out body-only matches that bm25 happened to rank high.
        let probe = normalize_for_fuzzy(query_raw);
        if probe.is_empty() {
            return Ok(Vec::new());
        }

        let mut hits = Vec::new();
        for row in rows {
            let Ok((story_id, story_name, category, story_code)) = row else { continue };
            let name_norm = normalize_for_fuzzy(&story_name);
            let code_norm = normalize_for_fuzzy(&story_code);
            if !name_norm.contains(&probe) && !code_norm.contains(&probe) {
                continue;
            }
            let (story_name, category) = labels
                .and_then(|c| c.label_for(&story_id))
                .map(|(name, label)| (name.to_string(), label.to_string()))
                .unwrap_or((story_name, category));
            hits.push(SegmentHit {
                story_id,
                story_name: story_name.clone(),
                category,
                segment_index: 0,
                segment_type: "header".to_string(),
                character_name: None,
                matched_text: story_name,
                match_target: "title".to_string(),
            });
        }
        Ok(hits)
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

        let results = self.search_stories_emitting(Some(app), trimmed)?;
        emit_search_progress(app, "完成", 1, 1, format!("命中 {} 篇", results.len()));
        Ok(results)
    }

    /// `search_stories` 的发进度版本，但**不**发终态事件——外层
    /// (`search_stories_with_progress` / `search_stories_ex_inner`)
    /// 各自还有收尾工作，终态由它们来发，免得进度条先跳「完成」再往回退。
    ///
    /// 每篇都 emit 一次会给事件总线灌进两千条消息（还都要过一次 JSON），
    /// 光是发事件就比扫描本身还贵，所以按批发。
    fn search_stories_emitting(
        &self,
        app: Option<&AppHandle>,
        trimmed: &str,
    ) -> Result<Vec<SearchResult>, String> {
        const SCAN_PROGRESS_STRIDE: usize = 32;

        let Some(app) = app else {
            return self.search_stories(trimmed);
        };

        emit_search_progress(app, "检索", 0, 0, "尝试全文索引");
        match self.search_stories_with_index(trimmed) {
            Ok(Some(results)) => {
                emit_search_progress(app, "索引检索", 1, 1, "使用全文索引完成");
                return Ok(results);
            }
            // 索引没建好 / 查询失败：往下走线性扫描。
            Ok(None) => {}
            Err(err) => {
                eprintln!(
                    "[INDEX] Failed to search using index ({}), fallback to linear scan",
                    err
                );
            }
        }

        self.scan_stories(trimmed, |done, total| {
            if done == 0 {
                emit_search_progress(app, "线性扫描", 0, total.max(1), "开始遍历");
            } else if done % SCAN_PROGRESS_STRIDE == 0 || done == total {
                emit_search_progress(
                    app,
                    "线性扫描",
                    done,
                    total.max(1),
                    format!("已扫描 {} / {}", done, total),
                );
            }
        })
    }

    pub fn get_story_entry(&self, story_id: &str) -> Result<StoryEntry, String> {
        let catalog = self.catalog()?;
        catalog
            .by_id
            .get(story_id)
            .map(|idx| catalog.stories[*idx].story.clone())
            .ok_or_else(|| format!("Story {} 不存在", story_id))
    }

    /// Return the previous/next story in the same storyGroup ordered by
    /// storySort. If the story is the first/last, the corresponding field is
    /// None. Derived purely from `story_review_table.json`; no extra index.
    pub fn get_story_neighbors(&self, story_id: &str) -> Result<crate::models::StoryNeighbors, String> {
        let catalog = self.catalog()?;
        let Some(target) = catalog.by_id.get(story_id) else {
            return Ok(crate::models::StoryNeighbors::default());
        };
        let group = &catalog.stories[*target].story.story_group;
        let Some(positions) = catalog.by_group.get(group) else {
            return Ok(crate::models::StoryNeighbors::default());
        };
        let Some(pos) = positions.iter().position(|idx| idx == target) else {
            return Ok(crate::models::StoryNeighbors::default());
        };

        let at = |offset: usize| catalog.stories[positions[offset]].story.clone();
        Ok(crate::models::StoryNeighbors {
            prev: (pos > 0).then(|| at(pos - 1)),
            next: (pos + 1 < positions.len()).then(|| at(pos + 1)),
        })
    }

    /// 查找指定 storyId 所在的 **章节 / 活动** 名。
    /// 返回如 "黑暗时代·上"、"和光同尘" 等；找不到返回 None。
    pub fn get_story_category_name(&self, story_id: &str) -> Result<Option<String>, String> {
        let catalog = self.catalog()?;
        Ok(catalog.by_id.get(story_id).and_then(|idx| {
            let name = catalog.stories[*idx].category_name.trim();
            (!name.is_empty()).then(|| name.to_string())
        }))
    }

    /// 提取匹配文本的上下文
    ///
    /// Return a clean preview of the segment body, collapsing any
    /// `\r\n` / `\n` runs to a single space and truncating to `max_chars`
    /// Unicode scalar values (appending "…" if we clipped). Used when the
    /// query matched a non-body column (speaker/title) so the preview
    /// should just show the whole short segment rather than the empty
    /// output of `extract_context`.
    fn clip_preview(raw: &str, max_chars: usize) -> String {
        let flattened = raw
            .replace('\r', " ")
            .replace('\n', " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let chars: Vec<char> = flattened.chars().collect();
        if chars.len() <= max_chars {
            flattened
        } else {
            let mut s: String = chars.iter().take(max_chars).collect();
            s.push('…');
            s
        }
    }

    /// 使用归一化后文本查找匹配位置，再把"归一化字符索引"映射回"原文字节位置"，
    /// 避免 NFKC/去标点造成的字节长度变化导致越界或错位（bug A1）。
    fn extract_context(&self, content: &str, query: &str) -> String {
        self.extract_context_any(content, std::iter::once(query))
    }

    /// 依次尝试多个探针，取第一个命中的上下文。归一化映射只建一次——
    /// 每个探针各调一次 `extract_context` 的话，整篇正文要被重新归一化
    /// 好几遍（CJK 查询会退回逐字探针，次数正好等于字数）。
    fn extract_context_any<'a>(
        &self,
        content: &str,
        probes: impl IntoIterator<Item = &'a str>,
    ) -> String {
        if content.is_empty() {
            return String::new();
        }

        // Build a parallel mapping: for each normalized char, remember the
        // original char index it came from. This lets us map a match position
        // back to the original content without byte-length surprises.
        //
        // `{@nickname}` 原位替换成「博士」，两个替换字符都映射回占位符开头。
        // 以前是先对整串做 `replace` 再枚举下标——那是**替换后**字符串的
        // 下标，最后却拿去切**原文**：占位符比「博士」长 9 个字符，命中点
        // 之前每出现一次，窗口就整体偏 9 格。窗口只有 ±50 字符，占位符密集
        // 的剧情里挑出的「上下文」根本不含命中的文字。
        const NICKNAME: &str = "{@nickname}";
        let nickname_char_len = NICKNAME.chars().count();
        let origin_chars: Vec<char> = content.chars().collect();
        let mut norm_chars: Vec<char> = Vec::with_capacity(origin_chars.len());
        let mut origin_char_for_norm: Vec<usize> = Vec::with_capacity(origin_chars.len());
        let mut orig_idx = 0usize;
        while orig_idx < origin_chars.len() {
            if origin_chars[orig_idx] == '{'
                && origin_chars[orig_idx..]
                    .iter()
                    .take(nickname_char_len)
                    .copied()
                    .eq(NICKNAME.chars())
            {
                // 与 `normalize_for_fuzzy` 的替换语义保持一致。
                for rep in ['博', '士'] {
                    norm_chars.push(rep);
                    origin_char_for_norm.push(orig_idx);
                }
                orig_idx += nickname_char_len;
                continue;
            }
            let ch = origin_chars[orig_idx];
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
            orig_idx += 1;
        }

        let norm_text: String = norm_chars.iter().collect();
        if norm_text.is_empty() {
            return String::new();
        }
        drop(norm_chars);

        // 调用方给的探针一般已经归一化过了，再归一化一次是幂等的，成本也低。
        for probe in probes {
            let probe = normalize_for_fuzzy(probe);
            if probe.is_empty() {
                continue;
            }
            if let Some(pos_byte) = norm_text.find(&probe) {
                // Byte position in `norm_text` → norm char index.
                let norm_char_index = norm_text[..pos_byte].chars().count();
                if norm_char_index >= origin_char_for_norm.len() {
                    continue;
                }
                let origin_char_start = origin_char_for_norm[norm_char_index];
                let probe_char_len = probe.chars().count();
                // 归一化丢掉了空白和标点，probe 的字符数换算不回原文跨度；
                // 用命中的最后一个归一化字符对应的原文位置来定右边界。
                let origin_char_end = origin_char_for_norm
                    .get(norm_char_index + probe_char_len - 1)
                    .map(|idx| idx + 1)
                    .unwrap_or(origin_chars.len());
                let window = 50usize;
                let snippet_start = origin_char_start.saturating_sub(window);
                let snippet_end = (origin_char_end + window).min(origin_chars.len());
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
        Ok(self.catalog()?.main_groups.clone())
    }

    fn build_main_groups(data: &HashMap<String, Value>) -> Vec<(String, Vec<StoryEntry>)> {
        // 按分组ID收集主线剧情
        let mut groups: Vec<(String, String, Vec<StoryEntry>)> = Vec::new();

        for (id, value) in data.iter() {
            if let Some(et) = value.get("entryType").and_then(|v| v.as_str()) {
                if et == "MAINLINE" {
                    let group_name = value
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("未知章节");

                    let mut stories = Self::parse_group_entries(value);
                    if !stories.is_empty() {
                        stories.sort_by_key(|s| s.story_sort);
                        groups.push((id.clone(), group_name.to_string(), stories));
                    }
                }
            }
        }

        groups.sort_by(|a, b| compare_story_group_ids(&a.0, &b.0));

        groups
            .into_iter()
            .map(|(_, name, stories)| (name, stories))
            .collect()
    }

    pub fn get_activity_stories_grouped(&self) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
        Ok(self.catalog()?.activity_groups.clone())
    }

    fn build_activity_groups(data: &HashMap<String, Value>) -> Vec<(String, Vec<StoryEntry>)> {
        let mut groups: Vec<(String, Vec<StoryEntry>, i64, String)> = Vec::new();

        for (_id, value) in data.iter() {
            if let Some(et) = value.get("entryType").and_then(|v| v.as_str()) {
                if et == "ACTIVITY" || et == "MINI_ACTIVITY" {
                    let activity_name = value
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("未知活动");

                    let mut stories = Self::parse_group_entries(value);
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

        // 按活动开始时间排序（旧活动在前，时间缺失的放在末尾）
        groups.sort_by(|a, b| match a.2.cmp(&b.2) {
            Ordering::Equal => compare_story_group_ids(&a.3, &b.3),
            other => other,
        });

        groups
            .into_iter()
            .map(|(name, stories, _, _)| (name, stories))
            .collect()
    }

    pub fn get_sidestory_stories_grouped(&self) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
        Ok(self.catalog()?.sidestory_groups.clone())
    }

    fn build_sidestory_groups(data: &HashMap<String, Value>) -> Vec<(String, Vec<StoryEntry>)> {
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

                let mut stories = Self::parse_group_entries(value);
                if !stories.is_empty() {
                    stories.sort_by_key(|s| s.story_sort);
                    groups.push((group_name.to_string(), stories, id.clone()));
                }
            }
        }

        groups.sort_by(|a, b| compare_story_group_ids(&a.2, &b.2));
        groups
            .into_iter()
            .map(|(name, stories, _)| (name, stories))
            .collect()
    }

    pub fn get_roguelike_stories_grouped(&self) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
        let catalog = self.catalog()?;
        // 只有在真的什么都没解析出来时才把读表错误抛给前端，避免为了一份
        // 缺失的 meta 表把整页肉鸽列表变成错误提示。
        if catalog.roguelike_groups.is_empty() {
            if let Some(err) = &catalog.roguelike_error {
                return Err(err.clone());
            }
        }
        Ok(catalog.roguelike_groups.clone())
    }

    /// 枚举 `story_table.json` 里的所有 `Obt/Roguelike/...` 剧情，按主题分组。
    /// 既服务于「肉鸽」列表页，也被 `collect_stories_for_index` 复用，
    /// 保证肉鸽剧情同样可搜索、可取上下篇。
    fn collect_roguelike_groups(&self) -> Result<Vec<(String, Vec<StoryEntry>)>, String> {
        // 首先读取 meta，提取 contentPath -> desc 映射（用于更友好的命名）
        let meta_file = self.data_dir.join(REVIEW_META_TABLE_REL);
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
        let story_table_file = self.data_dir.join(STORY_TABLE_REL);
        let story_table_content = fs::read_to_string(&story_table_file)
            .map_err(|e| format!("Failed to read story table file: {}", e))?;
        let table_obj: HashMap<String, Value> = serde_json::from_str(&story_table_content)
            .map_err(|e| format!("Failed to parse story table: {}", e))?;

        // `story_table` 是 HashMap，迭代顺序随机；先把命中的 key 排好序再
        // 分配 storySort，否则每次启动的编号（以及索引里的顺序）都不一样。
        let mut keys: Vec<String> = table_obj
            .into_keys()
            .filter(|key| key.to_ascii_lowercase().starts_with("obt/roguelike/"))
            .collect();
        keys.sort_by(|a, b| compare_story_group_ids(a, b));

        let mut grouped: BTreeMap<String, Vec<StoryEntry>> = BTreeMap::new();
        let mut counters: BTreeMap<String, i32> = BTreeMap::new();

        for key in keys {
            let lower = key.to_ascii_lowercase();
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
                story_pic: None,
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
        Ok(self.catalog()?.memory_stories.clone())
    }

    fn build_memory_stories(data: &HashMap<String, Value>) -> Vec<StoryEntry> {
        let mut stories = Self::parse_stories_by_entry_type(data, "NONE");

        // 干员密录的 storySort 在原始数据里几乎全是 0，直接按它排等于
        // 保留 HashMap 的随机顺序。改为按「干员 char token → 篇内序号 →
        // storyId」排，同一位干员的密录始终连在一起且顺序稳定。
        stories.sort_by(|a, b| {
            let a_char = extract_char_token(&a.story_txt).unwrap_or_else(|| a.story_name.clone());
            let b_char = extract_char_token(&b.story_txt).unwrap_or_else(|| b.story_name.clone());
            a_char
                .cmp(&b_char)
                .then_with(|| extract_numeric_parts(&a.story_txt).cmp(&extract_numeric_parts(&b.story_txt)))
                .then_with(|| a.story_name.cmp(&b.story_name))
                .then_with(|| a.story_id.cmp(&b.story_id))
        });
        stories
    }

    /// 读取剧情脚本，返回第一张可用作缩略图的素材 token。
    /// 优先 `[Image]`（真正的剧情插画），没有时退化到脚本里第一条
    /// `[Background]`——解析器有意丢弃 Background 段，所以这里直接扫原文。
    pub fn get_story_preview_token(
        &self,
        story_path: &str,
    ) -> Result<Option<StoryPreviewToken>, String> {
        let raw = self.read_story_text(story_path)?;

        let parsed = parse_story_text(&raw);
        for segment in &parsed.segments {
            if let StorySegment::Image { token, .. } = segment {
                let token = token.trim().trim_start_matches('$');
                if !token.is_empty() {
                    return Ok(Some(StoryPreviewToken {
                        kind: "image".to_string(),
                        token: token.to_string(),
                    }));
                }
            }
        }

        Ok(first_background_token(&raw).map(|token| StoryPreviewToken {
            kind: "background".to_string(),
            token,
        }))
    }
}

/// 从 `obt/memory/char_002_amiya/...` 这类路径里抓出 `char_002_amiya`。
fn extract_char_token(story_txt: &str) -> Option<String> {
    story_txt
        .split(|c| c == '/' || c == '\\')
        .find(|seg| seg.starts_with("char_"))
        .map(|seg| seg.to_ascii_lowercase())
}

/// 扫描原始脚本里第一条 `[Background(image="bg_xxx"...)]` 的 image token。
fn first_background_token(raw: &str) -> Option<String> {
    for line in raw.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('[') {
            continue;
        }
        // `to_ascii_lowercase` 不改变字节长度，偏移量可以直接用回原串。
        let lowered = trimmed.to_ascii_lowercase();
        if !lowered.starts_with("[background") {
            continue;
        }
        let Some(image_at) = lowered.find("image=") else {
            continue;
        };
        // 用原始大小写切片取值，token 本身可能含大写（如 `bg_Rhodes`）。
        let value = trimmed[image_at + "image=".len()..]
            .trim_start()
            .trim_start_matches('"');
        let end = value
            .find(|c: char| c == '"' || c == ',' || c == ')')
            .unwrap_or(value.len());
        let token = value[..end].trim().trim_start_matches('$').trim();
        if !token.is_empty() {
            return Some(token.to_string());
        }
    }
    None
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
    fn preview_token_prefers_image_then_background() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_root = std::env::temp_dir().join(format!("story_preview_test_{}", timestamp));
        let data_dir = temp_root.join("ArknightsGameData");
        let story_dir = data_dir.join("zh_CN/gamedata/story/demo");
        fs::create_dir_all(&story_dir).unwrap();
        fs::write(
            story_dir.join("with_image.txt"),
            "[Background(image=\"bg_rhodes\",screenadapt=\"coverall\")]\n\
             [Image(image=\"avg_8_34\",fadetime=2)]\n\
             [name=\"凯尔希\"]测试\n",
        )
        .unwrap();
        fs::write(
            story_dir.join("bg_only.txt"),
            "[Delay(time=1)]\n[Background(image=\"bg_Rhodes_1\",fadetime=2)]\n旁白\n",
        )
        .unwrap();
        fs::write(story_dir.join("plain.txt"), "[name=\"博士\"]没有插画\n").unwrap();

        let service = DataService {
            data_dir: data_dir.clone(),
            index_db_path: temp_root.join("story_index.db"),
        };

        let image = service
            .get_story_preview_token("demo/with_image")
            .unwrap()
            .expect("image segment wins over background");
        assert_eq!(image.kind, "image");
        assert_eq!(image.token, "avg_8_34");

        let background = service
            .get_story_preview_token("demo/bg_only")
            .unwrap()
            .expect("falls back to the first Background");
        assert_eq!(background.kind, "background");
        assert_eq!(background.token, "bg_Rhodes_1");

        assert!(service.get_story_preview_token("demo/plain").unwrap().is_none());

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn post_process_dedupes_consecutive_same_image() {
        let segments = vec![
            StorySegment::Image {
                token: "avg_1".to_string(),
                caption: None,
            },
            StorySegment::Image {
                token: "avg_1".to_string(),
                caption: None,
            },
            StorySegment::Image {
                token: "avg_2".to_string(),
                caption: None,
            },
            StorySegment::Image {
                token: "avg_1".to_string(),
                caption: None,
            },
        ];
        let processed = DataService::post_process_segments_for_index(&segments);
        let tokens: Vec<&str> = processed
            .iter()
            .filter_map(|s| match s {
                StorySegment::Image { token, .. } => Some(token.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(tokens, vec!["avg_1", "avg_2", "avg_1"]);
    }

    #[test]
    fn extract_char_token_from_memory_path() {
        assert_eq!(
            extract_char_token("obt/memory/char_002_amiya/char_002_amiya_1"),
            Some("char_002_amiya".to_string())
        );
        assert_eq!(extract_char_token("obt/main/level_main_01-01_beg"), None);
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

    /// `QueryTerms` 里存的是切好原子的 `Term`；断言时只看归一化后的原文。
    fn positive_texts(terms: &QueryTerms) -> Vec<Vec<&str>> {
        terms
            .positive
            .iter()
            .map(|group| group.iter().map(|t| t.text.as_str()).collect())
            .collect()
    }

    fn negative_texts(terms: &QueryTerms) -> Vec<&str> {
        terms.negative.iter().map(|t| t.text.as_str()).collect()
    }

    #[test]
    fn split_query_terms_basic() {
        let terms = split_query_terms("凯尔希 阿米娅");
        assert_eq!(positive_texts(&terms), vec![vec!["凯尔希"], vec!["阿米娅"]]);
        assert!(terms.negative.is_empty());
    }

    #[test]
    fn split_query_terms_quoted_phrase() {
        let terms = split_query_terms("\"凯尔希 阿米娅\"");
        // Quoted phrase collapses internal whitespace because of fuzzy normalization.
        assert_eq!(positive_texts(&terms), vec![vec!["凯尔希阿米娅"]]);
        // 短语只有一个原子：整串必须连续出现，对应 FTS 的 `"凯 尔 希 阿 米 娅"`。
        assert_eq!(terms.positive[0][0].atoms, vec!["凯尔希阿米娅"]);
        assert!(terms.positives_match(&["和凯尔希阿米娅一起"]));
        assert!(!terms.positives_match(&["凯尔希在，阿米娅不在"]));
    }

    #[test]
    fn split_query_terms_bare_cjk_is_char_level_like_the_index() {
        // 普通词对应 FTS 的 `("凯" AND "尔" AND "希")`：逐字命中即可，不要求
        // 连续。线性扫描必须用同样的判定，否则索引建好前后结果集会变。
        let terms = split_query_terms("凯尔希");
        assert_eq!(terms.positive[0][0].atoms, vec!["凯", "尔", "希"]);
        assert!(terms.positives_match(&["凯尔希"]));
        assert!(terms.positives_match(&["凯瑟琳、尔后、希望"]));
        assert!(!terms.positives_match(&["凯尔"]));
    }

    #[test]
    fn split_query_terms_ascii_run_is_one_atom() {
        let terms = split_query_terms("prts2");
        assert_eq!(terms.positive[0][0].atoms, vec!["prts2"]);
        // 索引里落不成 token 的字符（假名等）两边都当它不存在。
        assert!(split_query_terms("アイ").positive.is_empty());
    }

    #[test]
    fn split_query_terms_keeps_or_group_and_negation() {
        let terms = split_query_terms("凯尔希 or 阿米娅 -博士");
        // `or` merges the two names into one alternative group; `-博士` is an
        // exclusion, never a positive term.
        assert_eq!(positive_texts(&terms), vec![vec!["凯尔希", "阿米娅"]]);
        assert_eq!(negative_texts(&terms), vec!["博士"]);
    }

    #[test]
    fn split_query_terms_not_is_not_inverted() {
        let terms = split_query_terms("-凯尔希 博士");
        assert_eq!(positive_texts(&terms), vec![vec!["博士"]]);
        assert_eq!(negative_texts(&terms), vec!["凯尔希"]);
        assert!(terms.positives_match(&["博士说过的话"]));
        assert!(terms.excluded_by(&["凯尔希说过的话"]));
        assert!(!terms.excluded_by(&["博士说过的话"]));
    }

    #[test]
    fn split_query_terms_negated_phrase_stays_negative() {
        // `-"..."` 的减号在引号外，归一化会把它抹掉；不特判的话否定短语会
        // 变成肯定短语，语义正好反过来。
        let terms = split_query_terms("博士 -\"凯尔希\"");
        assert_eq!(positive_texts(&terms), vec![vec!["博士"]]);
        assert_eq!(negative_texts(&terms), vec!["凯尔希"]);
        assert!(terms.excluded_by(&["凯尔希来了"]));

        // 引号没闭合时同样保住否定语义。
        let terms = split_query_terms("博士 -\"凯尔希");
        assert_eq!(negative_texts(&terms), vec!["凯尔希"]);
    }

    #[test]
    fn split_query_terms_quoted_or_is_a_literal() {
        // 引号里的 `or` 是要搜的词，不是连接词。
        let terms = split_query_terms("\"or\" 博士");
        assert_eq!(positive_texts(&terms), vec![vec!["or"], vec!["博士"]]);
    }

    #[test]
    fn split_query_terms_or_group_matches_either_alternative() {
        let terms = split_query_terms("凯尔希 or 阿米娅");
        assert!(terms.positives_match(&["只提到凯尔希"]));
        assert!(terms.positives_match(&["只提到阿米娅"]));
        assert!(!terms.positives_match(&["只提到博士"]));
    }

    #[test]
    fn fts_query_escapes_specials_and_is_nonempty() {
        let q = DataService::build_fts_query_advanced("凯尔希*").expect("non-empty");
        // `*` is a FTS special and gets sanitized away for CJK terms.
        assert!(!q.contains('*'));
        // Every char of the term must still be present as its own token.
        for ch in ["凯", "尔", "希"] {
            assert!(q.contains(ch), "missing {} in {}", ch, q);
        }
    }

    #[test]
    fn fts_query_long_cjk_is_char_level_and() {
        let q = DataService::build_fts_query_advanced("凯尔希阿米娅").expect("non-empty");
        // Char-level tokenization: every CJK char becomes its own phrase,
        // AND-joined inside one parenthesized clause.
        assert_eq!(q, "(\"凯\" AND \"尔\" AND \"希\" AND \"阿\" AND \"米\" AND \"娅\")");
    }

    #[test]
    fn fts_query_short_cjk_word_is_char_level_and() {
        let q = DataService::build_fts_query_advanced("凯尔希").expect("non-empty");
        assert_eq!(q, "(\"凯\" AND \"尔\" AND \"希\")");
    }

    #[test]
    fn fts_query_single_cjk_char_has_no_connector() {
        let q = DataService::build_fts_query_advanced("希").expect("non-empty");
        assert_eq!(q, "\"希\"");
    }

    #[test]
    fn fts_query_ascii_gets_prefix_star() {
        let q = DataService::build_fts_query_advanced("prts").expect("non-empty");
        assert_eq!(q.trim(), "prts*");
    }

    #[test]
    fn fts_query_pure_punctuation_returns_none() {
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
        // The positive term must come BEFORE the NOT clause — otherwise FTS5
        // rejects the query with "unable to use function MATCH".
        let not_idx = q.find("NOT").unwrap();
        let bodhi_idx = q.find('博').unwrap();
        assert!(
            bodhi_idx < not_idx,
            "positive term must precede NOT; got: {}",
            q
        );
    }

    #[test]
    fn fts_query_pure_negation_returns_none() {
        // A query that's only exclusions can't be expressed in FTS5 —
        // we return None so the caller short-circuits to empty results.
        assert!(DataService::build_fts_query_advanced("-凯尔希").is_none());
        assert!(DataService::build_fts_query_advanced("-凯尔希 -博士").is_none());
    }

    #[test]
    fn fts_query_or_is_applied_before_and() {
        // `凯尔希 or 阿米娅 博士` should group the first two with OR and
        // AND on the third. We don't enforce parenthesization, but at
        // minimum both OR and AND must be present.
        let q = DataService::build_fts_query_advanced("凯尔希 or 阿米娅 博士").expect("non-empty");
        assert!(q.contains("OR"));
        assert!(q.contains("AND"));
    }

    #[test]
    fn tokenize_for_fts_emits_single_cjk_chars() {
        // No word segmentation any more: CJK is indexed one char at a time.
        let tokens = DataService::tokenize_for_fts("凯尔希 博士");
        assert_eq!(tokens, vec!["凯", "尔", "希", "博", "士"]);
    }

    #[test]
    fn tokenize_for_fts_ascii_keeps_runs() {
        let tokens = DataService::tokenize_for_fts("PRTS system");
        assert!(tokens.iter().any(|t| t == "prts"));
        assert!(tokens.iter().any(|t| t == "system"));
    }

    #[test]
    fn fts_query_or_binds_looser_than_and() {
        // FTS5 里 AND 结合得比 OR 紧，`A OR B AND C` 会被解析成
        // `A OR (B AND C)`；线性扫描按 `(A OR B) AND C` 判定。不显式加括号
        // 的话，同一个查询在索引可用与否两种状态下答案不一样。
        let q = DataService::build_fts_query_advanced("希 or 章 雪").expect("non-empty");
        assert_eq!(q, "(\"希\" OR \"章\") AND \"雪\"");
    }

    #[test]
    fn fts_query_negated_phrase_is_excluded() {
        let q = DataService::build_fts_query_advanced("博士 -\"凯尔希\"").expect("non-empty");
        let not_idx = q.find(" NOT ").expect("否定短语必须落在 NOT 子句里");
        assert!(q[..not_idx].contains('博'), "positives first: {}", q);
        assert!(q[not_idx..].contains('凯'), "phrase must be negated: {}", q);
    }

    #[test]
    fn fts_query_wraps_positives_before_not() {
        // FTS5 binds `NOT` tighter than we want: without the parentheses
        // `A AND B NOT C` would exclude only from `B`.
        let q = DataService::build_fts_query_advanced("凯尔希 阿米娅 -博士").expect("non-empty");
        assert!(q.starts_with('('), "positives must be grouped: {}", q);
        let not_idx = q.find(" NOT ").expect("NOT clause");
        assert!(q[..not_idx].contains("AND"), "both positives kept: {}", q);
    }

    // ---- Dataset fixture ---------------------------------------------------

    static FIXTURE_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    /// A throw-away app-data directory holding a miniature but structurally
    /// faithful ArknightsGameData tree: two mainline stories, one activity,
    /// one operator memory and two roguelike scripts.
    struct Fixture {
        root: PathBuf,
        service: DataService,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let mut guard = CATALOG_CACHE.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(map) = guard.as_mut() {
                map.remove(&self.service.data_dir);
            }
            drop(guard);
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let seq = FIXTURE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!("ark_{}_{}_{}", tag, nanos, seq));
            let data_dir = root.join("ArknightsGameData");
            let service = DataService {
                data_dir: data_dir.clone(),
                index_db_path: root.join("story_index.db"),
            };
            let fixture = Fixture { root, service };
            fixture.install_dataset();
            fixture
        }

        fn excel(&self) -> PathBuf {
            self.service.data_dir.join("zh_CN/gamedata/excel")
        }

        fn write_file(path: &Path, body: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body).unwrap();
        }

        fn write_story(&self, rel: &str, body: &str) {
            let path = self
                .service
                .data_dir
                .join("zh_CN/gamedata/story")
                .join(format!("{}.txt", rel));
            Self::write_file(&path, body);
        }

        fn set_version(&self, commit: &str) {
            Self::write_file(
                &self.service.data_dir.join(VERSION_FILE),
                &format!("{{\"commit\":\"{}\",\"fetched_at\":1700000000}}", commit),
            );
        }

        fn set_review_table(&self, json: &str) {
            Self::write_file(&self.excel().join("story_review_table.json"), json);
        }

        fn install_dataset(&self) {
            self.set_review_table(REVIEW_TABLE_JSON);
            Self::write_file(&self.excel().join("story_table.json"), STORY_TABLE_JSON);
            Self::write_file(
                &self.excel().join("story_review_meta_table.json"),
                REVIEW_META_JSON,
            );

            // 主线一：同时出现「凯尔希」和「博士」，用来验证 NOT 排除。
            self.write_story(
                "obt/main/level_main_00-01",
                "[name=\"凯尔希\"]博士，你醒了。\n",
            );
            self.write_story("obt/main/level_main_00-02", "[name=\"阿米娅\"]我们出发吧。\n");
            // 活动篇开头连着两张同名插画，前端会合并，索引也必须合并，
            // 否则对白段落号会整体偏移一位。
            self.write_story(
                "activities/act1/act1_st01",
                "[Image(image=\"avg_1\")]\n[Image(image=\"avg_1\")]\n[name=\"德克萨斯\"]雪很大。\n",
            );
            self.write_story("obt/memory/char_002_amiya/char_002_amiya_1", "回忆片段。\n");
            self.write_story("obt/roguelike/ro2/ro2_1", "[name=\"凯尔希\"]又见面了。\n");
            self.write_story("obt/roguelike/ro2/ro2_2", "[name=\"缄默\"]继续前进。\n");
            self.set_version("commit-1");
        }
    }

    fn entry_json(id: &str, name: &str, group: &str, sort: i32, txt: &str, code: &str) -> String {
        format!(
            "{{\"storyId\":\"{id}\",\"storyName\":\"{name}\",\"storyCode\":\"{code}\",\
             \"storyGroup\":\"{group}\",\"storySort\":{sort},\"storyTxt\":\"{txt}\",\
             \"storyReviewType\":\"NORMAL\",\"unLockType\":\"AUTO\"}}"
        )
    }

    const REVIEW_TABLE_JSON: &str = r#"{
      "main_0": {
        "id": "main_0",
        "name": "黑暗时代",
        "entryType": "MAINLINE",
        "actType": "NONE",
        "startTime": 100,
        "storyPic": "chapter_cover_0",
        "infoUnlockDatas": [
          {"storyId":"main_00-01","storyName":"序章","storyCode":"0-1","storyGroup":"main_0","storySort":1,"storyTxt":"obt/main/level_main_00-01","storyReviewType":"NORMAL","unLockType":"AUTO"},
          {"storyId":"main_00-02","storyName":"启程","storyCode":"0-2","storyGroup":"main_0","storySort":2,"storyTxt":"obt/main/level_main_00-02","storyReviewType":"NORMAL","unLockType":"AUTO"}
        ]
      },
      "act_1": {
        "id": "act_1",
        "name": "骑兵与猎人",
        "entryType": "ACTIVITY",
        "actType": "ACTIVITY_STORY",
        "startTime": 200,
        "storyPic": "act1_kv",
        "infoUnlockDatas": [
          {"storyId":"act1_st01","storyName":"雪原","storyGroup":"act_1","storySort":1,"storyTxt":"activities/act1/act1_st01","storyReviewType":"NORMAL","unLockType":"AUTO"}
        ]
      },
      "memory_amiya": {
        "id": "memory_amiya",
        "name": "阿米娅密录",
        "entryType": "NONE",
        "infoUnlockDatas": [
          {"storyId":"memory_amiya_1","storyName":"回忆","storyGroup":"memory_amiya","storySort":0,"storyTxt":"obt/memory/char_002_amiya/char_002_amiya_1","storyReviewType":"NORMAL","unLockType":"AUTO"}
        ]
      }
    }"#;

    const STORY_TABLE_JSON: &str = r#"{
      "Obt/Roguelike/ro2/ro2_1": {"id":"Obt/Roguelike/ro2/ro2_1"},
      "Obt/Roguelike/ro2/ro2_2": {"id":"Obt/Roguelike/ro2/ro2_2"},
      "Obt/Main/level_main_00-01": {"id":"Obt/Main/level_main_00-01"}
    }"#;

    const REVIEW_META_JSON: &str = r#"{
      "miniActTrialData": {},
      "roguelike": {
        "one": {"contentPath":"obt/roguelike/ro2/ro2_1","desc":"孤钻·壹"},
        "two": {"contentPath":"obt/roguelike/ro2/ro2_2","desc":"孤钻·贰"}
      }
    }"#;

    // ---- Catalog memoization ----------------------------------------------

    #[test]
    fn catalog_is_parsed_once_across_commands() {
        let fx = Fixture::new("memo");
        let dir = fx.service.data_dir.clone();
        let before = catalog_build_count(&dir);

        fx.service.get_main_stories_grouped().unwrap();
        fx.service.get_activity_stories_grouped().unwrap();
        fx.service.get_sidestory_stories_grouped().unwrap();
        fx.service.get_roguelike_stories_grouped().unwrap();
        fx.service.get_memory_stories().unwrap();
        fx.service.get_story_categories().unwrap();
        fx.service.get_story_entry("main_00-01").unwrap();
        fx.service.get_story_neighbors("main_00-01").unwrap();
        fx.service.get_story_category_name("main_00-01").unwrap();

        assert_eq!(
            catalog_build_count(&dir) - before,
            1,
            "story_review_table.json must be parsed once for the whole batch"
        );
    }

    #[test]
    fn catalog_cache_is_invalidated_by_new_commit() {
        let fx = Fixture::new("memo_commit");
        let dir = fx.service.data_dir.clone();
        let before = catalog_build_count(&dir);

        fx.service.get_main_stories_grouped().unwrap();
        assert_eq!(catalog_build_count(&dir) - before, 1);

        // A sync rewrites version.json even when nothing else moved.
        fx.set_version("commit-2");
        fx.service.get_main_stories_grouped().unwrap();
        assert_eq!(
            catalog_build_count(&dir) - before,
            2,
            "a new commit must invalidate the cached catalog"
        );
    }

    #[test]
    fn catalog_cache_is_invalidated_by_table_rewrite() {
        let fx = Fixture::new("memo_table");
        let dir = fx.service.data_dir.clone();
        let before = catalog_build_count(&dir);

        assert!(fx.service.get_story_entry("main_00-03").is_err());
        assert_eq!(catalog_build_count(&dir) - before, 1);

        // Same commit, different table: a hand-swapped dataset must not be
        // served from the previous parse.
        fx.set_review_table(&format!(
            "{{\"main_0\":{{\"id\":\"main_0\",\"name\":\"黑暗时代\",\"entryType\":\"MAINLINE\",\
              \"infoUnlockDatas\":[{}]}}}}",
            entry_json(
                "main_00-03",
                "追加",
                "main_0",
                3,
                "obt/main/level_main_00-03",
                "0-3",
            )
        ));

        let entry = fx
            .service
            .get_story_entry("main_00-03")
            .expect("rewritten table must be re-read");
        assert_eq!(entry.story_name, "追加");
        assert_eq!(catalog_build_count(&dir) - before, 2);
    }

    #[test]
    fn catalog_lookups_cover_neighbors_and_category() {
        let fx = Fixture::new("lookup");

        let neighbors = fx.service.get_story_neighbors("main_00-01").unwrap();
        assert!(neighbors.prev.is_none());
        assert_eq!(neighbors.next.map(|s| s.story_id), Some("main_00-02".into()));

        let neighbors = fx.service.get_story_neighbors("main_00-02").unwrap();
        assert_eq!(neighbors.prev.map(|s| s.story_id), Some("main_00-01".into()));
        assert!(neighbors.next.is_none());

        assert_eq!(
            fx.service.get_story_category_name("act1_st01").unwrap(),
            Some("骑兵与猎人".to_string())
        );
        assert!(fx.service.get_story_entry("does_not_exist").is_err());
        assert_eq!(
            fx.service
                .get_story_neighbors("does_not_exist")
                .unwrap()
                .next
                .is_none(),
            true
        );
    }

    #[test]
    fn roguelike_stories_join_catalog_and_groups() {
        let fx = Fixture::new("rogue");
        let catalog = fx.service.catalog().unwrap();

        let rogue: Vec<&IndexedStory> = catalog
            .stories
            .iter()
            .filter(|s| s.category_label.starts_with("肉鸽"))
            .collect();
        assert_eq!(rogue.len(), 2, "both roguelike scripts must be indexable");
        assert!(catalog.by_id.contains_key("Obt/Roguelike/ro2/ro2_1"));

        let groups = fx.service.get_roguelike_stories_grouped().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].0, "RO2");
        assert_eq!(groups[0].1[0].story_name, "孤钻·壹");
    }

    #[test]
    fn memory_and_activity_groups_come_from_the_same_parse() {
        let fx = Fixture::new("groups");

        let main = fx.service.get_main_stories_grouped().unwrap();
        assert_eq!(main.len(), 1);
        assert_eq!(main[0].0, "黑暗时代");
        assert_eq!(main[0].1.len(), 2);

        // 大型活动同时出现在「活动」和「支线」两个入口。
        assert_eq!(fx.service.get_activity_stories_grouped().unwrap().len(), 1);
        assert_eq!(fx.service.get_sidestory_stories_grouped().unwrap().len(), 1);

        let memory = fx.service.get_memory_stories().unwrap();
        assert_eq!(memory.len(), 1);
        assert_eq!(memory[0].story_id, "memory_amiya_1");

        // 条目自身没有 storyPic 时，回填所在组的封面。
        assert_eq!(main[0].1[0].story_pic.as_deref(), Some("chapter_cover_0"));
    }

    // ---- Index + search end to end ----------------------------------------

    #[test]
    fn index_search_covers_roguelike_not_and_segment_offsets() {
        let fx = Fixture::new("search");
        fx.service.rebuild_story_index().expect("index builds");

        let page = fx.service.search_stories_ex("凯尔希").unwrap();
        let ids: Vec<&str> = page.results.iter().map(|r| r.story_id.as_str()).collect();
        assert!(ids.contains(&"main_00-01"), "got {:?}", ids);
        assert!(
            ids.contains(&"Obt/Roguelike/ro2/ro2_1"),
            "roguelike must be searchable, got {:?}",
            ids
        );

        // `-博士` may only drop the mainline story; the roguelike one never
        // mentions 博士 and must survive.
        let page = fx.service.search_stories_ex("凯尔希 -博士").unwrap();
        let ids: Vec<&str> = page.results.iter().map(|r| r.story_id.as_str()).collect();
        assert_eq!(ids, vec!["Obt/Roguelike/ro2/ro2_1"], "NOT semantics");

        // Purely negative queries have no answer rather than "everything".
        assert!(fx.service.search_stories_ex("-凯尔希").unwrap().results.is_empty());

        // Two identical consecutive [Image] collapse into one, so the line
        // after them is segment #1 — the index the reader scrolls to.
        let segs = fx.service.search_segments("雪很大").unwrap();
        assert_eq!(segs.hits.len(), 1);
        assert_eq!(segs.hits[0].story_id, "act1_st01");
        assert_eq!(segs.hits[0].segment_index, 1);
        assert_eq!(segs.hits[0].character_name.as_deref(), Some("德克萨斯"));

        // Title lookups surface even though no segment body carries them.
        let segs = fx.service.search_segments("启程").unwrap();
        assert!(segs.hits.iter().any(|h| h.story_id == "main_00-02"));

        let status = fx.service.get_story_index_status().unwrap();
        assert!(status.ready);
        assert_eq!(status.total, 6);
    }

    #[test]
    fn fallback_scan_matches_index_on_not_queries() {
        let fx = Fixture::new("fallback");
        // No index built: this exercises the linear scanner.
        let results = fx.service.search_stories("凯尔希 -博士").unwrap();
        let ids: Vec<&str> = results.iter().map(|r| r.story_id.as_str()).collect();
        assert_eq!(ids, vec!["Obt/Roguelike/ro2/ro2_1"]);
    }

    fn sorted_ids(results: &[SearchResult]) -> Vec<String> {
        let mut ids: Vec<String> = results.iter().map(|r| r.story_id.clone()).collect();
        ids.sort();
        ids
    }

    /// 索引建好前后，同一个查询必须给出同一批剧情。两条路径各自实现一套
    /// 判定，任何一边改了切词或语料范围都会在这里炸出来。
    #[test]
    fn fallback_and_index_return_the_same_stories() {
        let fx = Fixture::new("agree");
        let queries = [
            "凯尔希",
            "凯尔希 -博士",
            "德克萨斯",
            "\"博士，你醒了\"",
            "凯尔希 or 德克萨斯",
            // (凯尔希 OR 德克萨斯) AND 雪 —— 只有活动篇同时满足。
            "凯尔希 or 德克萨斯 雪",
            "启程",
            // 脚本指令、素材 token：渲染出来的正文里没有，两边都不该命中。
            "avg_1",
            "image",
        ];

        let scanned: Vec<Vec<String>> = queries
            .iter()
            .map(|q| sorted_ids(&fx.service.search_stories(q).unwrap()))
            .collect();

        fx.service.rebuild_story_index().expect("index builds");
        for (query, expected) in queries.iter().zip(scanned) {
            let indexed = sorted_ids(&fx.service.search_stories(query).unwrap());
            assert_eq!(indexed, expected, "查询「{}」两条路径结果不一致", query);
        }
    }

    /// 上一条测的是「两边一样」，这条钉住具体值，免得两边一起错。
    #[test]
    fn scan_searches_rendered_text_not_script_commands() {
        let fx = Fixture::new("corpus");

        // 台词、说话人、标题都能搜到。
        assert_eq!(
            sorted_ids(&fx.service.search_stories("德克萨斯").unwrap()),
            vec!["act1_st01".to_string()]
        );
        // 解析器丢掉的指令文字搜不到——它们本来就不在索引里。
        assert!(fx.service.search_stories("avg_1").unwrap().is_empty());
        assert!(fx.service.search_stories("image").unwrap().is_empty());
        // OR 组与 AND 的结合律：只有同时满足「雪」的活动篇入选。
        assert_eq!(
            sorted_ids(&fx.service.search_stories("凯尔希 or 德克萨斯 雪").unwrap()),
            vec!["act1_st01".to_string()]
        );
    }

    #[test]
    fn scan_reports_a_real_denominator() {
        let fx = Fixture::new("scan_progress");
        let total = fx.service.catalog().unwrap().stories.len();

        let mut ticks: Vec<(usize, usize)> = Vec::new();
        let results = fx
            .service
            .scan_stories("凯尔希", |done, of| ticks.push((done, of)))
            .unwrap();

        assert!(!results.is_empty());
        // 开扫前就报出真实分母，收尾时一定走到底——进度条不会停在半路。
        assert_eq!(ticks.first().copied(), Some((0, total)));
        assert_eq!(ticks.last().copied(), Some((total, total)));
        assert!(ticks.windows(2).all(|w| w[0].0 <= w[1].0), "{:?}", ticks);
    }

    #[test]
    fn preview_never_comes_back_empty() {
        let fx = Fixture::new("preview");
        let content = "序章\n凯尔希：博士，你醒了。\n阿米娅：我们出发吧。";

        // 整词在正文里并不连续，退回单字原子仍要给出上下文。
        let terms = split_query_terms("凯尔希阿米娅");
        let preview = fx.service.preview_for(content, terms.primary());
        assert!(preview.contains("凯尔希"), "{}", preview);

        // 一个字都对不上时给开头预览，而不是一个空字符串。
        let terms = split_query_terms("缄默");
        let preview = fx.service.preview_for(content, terms.primary());
        assert!(!preview.trim().is_empty());
    }

    #[test]
    fn extract_context_takes_the_first_matching_probe() {
        let fx = Fixture::new("context");
        let content = "序章\n凯尔希：博士，你醒了。";

        let snippet = fx.service.extract_context_any(content, ["缄默", "醒了"]);
        assert!(snippet.contains("醒了"), "{}", snippet);
        // 一个都对不上就返回空串，兜底交给调用方。
        assert!(fx.service.extract_context_any(content, ["缄默"]).is_empty());
        // 归一化对齐：查询里没有标点也能定位到原文。
        assert!(fx
            .service
            .extract_context(content, "博士你醒了")
            .contains("你醒了"));
    }

    #[test]
    fn extract_context_stays_aligned_after_nickname_placeholders() {
        let fx = Fixture::new("nickname_ctx");

        // `{@nickname}` 比替换出的「博士」长 9 个字符。命中点之前每出现一
        // 次，按「替换后下标切原文」的旧算法就偏 9 格；垫 20 个占位符让偏
        // 移（180 字符）远超窗口（±50），错位实现挑出的片段必然不含命中文本。
        let mut content = String::new();
        for _ in 0..20 {
            content.push_str("{@nickname}，请听我说。\n");
        }
        content.push_str("凯尔希：罗德岛不会忘记你。");

        let snippet = fx.service.extract_context(&content, "罗德岛不会忘记你");
        assert!(
            snippet.contains("罗德岛不会忘记你"),
            "上下文必须包含命中的原文，实际: {}",
            snippet
        );

        // 探针跨过占位符本身也要能定位，片段展示的是原文（含占位符）。
        let snippet = fx
            .service
            .extract_context("{@nickname}，欢迎回来。", "博士欢迎回来");
        assert!(snippet.contains("欢迎回来"), "{}", snippet);
    }

    #[test]
    fn searchable_text_is_title_plus_rendered_body() {
        let segments = vec![
            StorySegment::Header {
                title: "第一节".to_string(),
            },
            StorySegment::Dialogue {
                character_name: "凯尔希".to_string(),
                text: "博士。".to_string(),
                position: None,
                character_id: None,
            },
            StorySegment::Music {
                key: "$bgm".to_string(),
            },
            StorySegment::Image {
                token: "avg_1".to_string(),
                caption: None,
            },
        ];
        // 标题参与索引；BGM 和无标题插画不参与。
        assert_eq!(
            DataService::searchable_text("序章", &segments),
            "序章\n第一节\n凯尔希：博士。"
        );
    }

    #[test]
    fn index_rebuild_is_skipped_when_already_current() {
        let fx = Fixture::new("index_skip");
        let db = fx.service.index_db_path.clone();
        let before = index_build_count(&db);

        fx.service.rebuild_story_index().expect("first build");
        assert_eq!(index_build_count(&db) - before, 1);

        fx.service.rebuild_story_index().expect("second build");
        assert_eq!(
            index_build_count(&db) - before,
            1,
            "指纹没变时重建应该整个跳过"
        );

        // 换了数据集就必须重建。
        fx.set_version("commit-2");
        fx.service.rebuild_story_index().expect("rebuild after sync");
        assert_eq!(index_build_count(&db) - before, 2);

        // 索引被清掉（同步/导入会清）之后同样必须重建。
        fx.service.clear_story_index().expect("clear");
        fx.service.rebuild_story_index().expect("rebuild after clear");
        assert_eq!(index_build_count(&db) - before, 3);

        let status = fx.service.get_story_index_status().unwrap();
        assert!(status.ready);
        assert_eq!(status.total, 6);
    }

    #[test]
    fn story_categories_follow_chapter_order() {
        let fx = Fixture::new("categories");
        let categories = fx.service.get_story_categories().unwrap();
        assert_eq!(categories.len(), 1);
        let ids: Vec<&str> = categories[0]
            .stories
            .iter()
            .map(|s| s.story_id.as_str())
            .collect();
        assert_eq!(ids, vec!["main_00-01", "main_00-02"]);
    }

    // ---- Update checks -----------------------------------------------------

    #[test]
    fn check_update_never_nags_without_a_comparable_commit() {
        let fx = Fixture::new("update");

        for commit in ["unknown", "manual-1700000000", ""] {
            fx.set_version(commit);
            assert_eq!(
                fx.service.check_update().unwrap(),
                false,
                "commit {:?} is not comparable, must not report an update",
                commit
            );
        }

        // 完全没有数据时才提示用户下载。
        fs::remove_file(fx.service.data_dir.join(VERSION_FILE)).unwrap();
        assert!(fx.service.check_update().unwrap());
    }

    // ---- ZIP install safety ------------------------------------------------

    fn write_zip(path: &Path, entries: &[(&str, &str)]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn extract_keeps_old_data_when_zip_lacks_review_table() {
        let fx = Fixture::new("zip_bad");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let zip_path = parent.join("bad.zip");
        write_zip(&zip_path, &[("pkg/README.md", "nothing useful here")]);

        let err = fx
            .service
            .extract_zip_at(&zip_path, &parent, None)
            .expect_err("a package without the review table must be rejected");
        assert!(err.contains("ZIP 校验失败"), "{}", err);

        assert!(
            fx.service.is_installed(),
            "the previous dataset must survive a rejected package"
        );
        assert_eq!(
            fx.service.get_story_entry("main_00-01").unwrap().story_name,
            "序章"
        );
        assert!(!parent.join("ArknightsGameData_extract").exists());
    }

    #[test]
    fn extract_rejects_empty_review_table() {
        let fx = Fixture::new("zip_empty");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let zip_path = parent.join("empty.zip");
        write_zip(
            &zip_path,
            &[("pkg/zh_CN/gamedata/excel/story_review_table.json", "")],
        );

        assert!(fx.service.extract_zip_at(&zip_path, &parent, None).is_err());
        assert!(fx.service.is_installed());
    }

    #[test]
    fn extract_replaces_data_and_prunes_unused_dirs() {
        let fx = Fixture::new("zip_ok");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let zip_path = parent.join("good.zip");
        write_zip(
            &zip_path,
            &[
                (
                    "pkg/zh_CN/gamedata/excel/story_review_table.json",
                    REVIEW_TABLE_JSON,
                ),
                ("pkg/zh_CN/gamedata/levels/obt/main/level.json", "{}"),
                ("pkg/zh_CN/gamedata/battle/buff.json", "{}"),
                ("pkg/zh_CN/gamedata/story/obt/main/level_main_00-01.txt", "文本"),
            ],
        );

        // 旧目录里的东西必须被整体替换掉，而不是与新包混在一起。
        Fixture::write_file(&fx.service.data_dir.join("stale.txt"), "old");

        fx.service
            .extract_zip_at(&zip_path, &parent, None)
            .expect("a valid package installs");

        assert!(fx.service.is_installed());
        assert!(!fx.service.data_dir.join("stale.txt").exists());
        assert!(!fx.service.data_dir.join("zh_CN/gamedata/levels").exists());
        assert!(!fx.service.data_dir.join("zh_CN/gamedata/battle").exists());
        assert!(fx
            .service
            .data_dir
            .join("zh_CN/gamedata/story/obt/main/level_main_00-01.txt")
            .exists());
        assert!(!parent.join("ArknightsGameData_extract").exists());
    }

    #[test]
    fn install_invalidates_the_cached_catalog() {
        let fx = Fixture::new("zip_cache");
        let dir = fx.service.data_dir.clone();
        let before = catalog_build_count(&dir);
        assert_eq!(fx.service.get_main_stories_grouped().unwrap().len(), 1);

        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let zip_path = parent.join("replacement.zip");
        // 新包里只有活动，没有主线。
        let review_without_mainline = r#"{
          "act_1": {
            "id": "act_1",
            "name": "骑兵与猎人",
            "entryType": "ACTIVITY",
            "actType": "ACTIVITY_STORY",
            "startTime": 200,
            "infoUnlockDatas": [
              {"storyId":"act1_st01","storyName":"雪原","storyGroup":"act_1","storySort":1,"storyTxt":"activities/act1/act1_st01","storyReviewType":"NORMAL","unLockType":"AUTO"}
            ]
          }
        }"#;
        write_zip(
            &zip_path,
            &[(
                "pkg/zh_CN/gamedata/excel/story_review_table.json",
                review_without_mainline,
            )],
        );

        fx.service
            .extract_zip_at(&zip_path, &parent, None)
            .expect("install");

        assert!(
            fx.service.get_main_stories_grouped().unwrap().is_empty(),
            "the catalog cached before the install must have been dropped"
        );
        assert!(catalog_build_count(&dir) > before);
    }

    #[test]
    fn swap_restores_old_data_when_new_tree_cannot_land() {
        let fx = Fixture::new("swap_rollback");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();

        // 新目录不存在：rename 和整树拷贝都必然失败，逼出回滚路径。
        let missing = parent.join("does_not_exist");
        let err = fx
            .service
            .swap_in_extracted(&missing)
            .expect_err("swapping in a missing tree must fail");
        assert!(!err.is_empty());

        assert!(
            fx.service.is_installed(),
            "换入失败后旧数据必须原样回到 data_dir"
        );
        assert_eq!(
            fx.service.get_story_entry("main_00-01").unwrap().story_name,
            "序章"
        );
        assert!(
            !parent.join("ArknightsGameData_old").exists(),
            "回滚之后不应留下暂存目录"
        );
    }

    #[test]
    fn extract_cleans_stale_aside_dir_from_previous_crash() {
        let fx = Fixture::new("zip_stale_aside");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();

        // 模拟上一次换入在「挪开旧目录」之后崩溃留下的残骸。
        let stale = parent.join("ArknightsGameData_old");
        Fixture::write_file(&stale.join("marker.txt"), "left by a crash");

        let zip_path = parent.join("good.zip");
        write_zip(
            &zip_path,
            &[(
                "pkg/zh_CN/gamedata/excel/story_review_table.json",
                REVIEW_TABLE_JSON,
            )],
        );

        fx.service
            .extract_zip_at(&zip_path, &parent, None)
            .expect("a valid package installs over a stale aside dir");

        assert!(fx.service.is_installed());
        assert!(
            !stale.exists(),
            "成功换入后不应留下任何 _old 暂存目录（包括崩溃残骸）"
        );
    }

    // ---- Crash recovery on startup ------------------------------------------

    /// 模拟换入恰好在两次改名之间崩溃：data_dir 已挪到 `_old`、新目录还没
    /// 落位。下一次启动（DataService::new）必须把数据接回来，而不是让
    /// is_installed 误报「未安装」。
    #[test]
    fn new_restores_aside_left_by_crash_between_renames() {
        let fx = Fixture::new("recover_fixed");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let aside = parent.join("ArknightsGameData_old");
        fs::rename(&fx.service.data_dir, &aside).unwrap();
        assert!(!fx.service.is_installed(), "崩溃现场：数据目录已消失");

        let relaunched = DataService::new(fx.root.clone());
        assert!(
            relaunched.is_installed(),
            "重启后必须从 _old 暂存目录恢复数据"
        );
        assert!(!aside.exists(), "恢复即改名回 data_dir，不留副本");
        assert_eq!(
            relaunched.get_story_entry("main_00-01").unwrap().story_name,
            "序章"
        );
    }

    /// 固定名 `_old` 清不掉时换入会退化成带时间戳的暂存名。恢复必须选
    /// 时间戳最大的那份——它来自最近一次换入，固定名残骸是更早的数据集。
    #[test]
    fn new_restores_newest_timestamped_aside() {
        let fx = Fixture::new("recover_stamped");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();

        // 更早的残骸：数据有效，但不是最近一次换入挪出去的。
        let stale = parent.join("ArknightsGameData_old");
        Fixture::write_file(&stale.join(REVIEW_TABLE_REL), REVIEW_TABLE_JSON);
        Fixture::write_file(&stale.join("stale_marker.txt"), "older dataset");

        // 最近一次换入挪出去的现场（带时间戳的退化名字）。
        let fresh = parent.join("ArknightsGameData_old_1700000000000000000");
        fs::rename(&fx.service.data_dir, &fresh).unwrap();

        let relaunched = DataService::new(fx.root.clone());
        assert!(relaunched.is_installed());
        assert!(
            !relaunched.data_dir.join("stale_marker.txt").exists(),
            "必须恢复时间戳最大的暂存目录，而不是更早的固定名残骸"
        );
        assert!(!fresh.exists());
        assert!(stale.exists(), "没被选中的残骸原样留给下一次换入清理");
    }

    /// 只认包含非空 story_review_table.json 的暂存目录：空壳恢复回去也
    /// 撑不起应用，反而会挡住之后正常的下载安装。
    #[test]
    fn new_ignores_aside_without_valid_review_table() {
        let fx = Fixture::new("recover_invalid");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        fs::remove_dir_all(&fx.service.data_dir).unwrap();

        let shell = parent.join("ArknightsGameData_old");
        Fixture::write_file(&shell.join(REVIEW_TABLE_REL), ""); // 空表 = 无效
        Fixture::write_file(&shell.join("marker.txt"), "crash shell");

        let relaunched = DataService::new(fx.root.clone());
        assert!(!relaunched.is_installed(), "空壳残骸不该被当成数据恢复");
        assert!(!relaunched.data_dir.exists());
        assert!(shell.exists(), "无效残骸原样保留，等下一次换入开场清理");
    }

    /// data_dir 还健在时绝不能动：成功换入后清理失败留下的 `_old` 是上
    /// 一份数据，抢着恢复反而会把新数据顶掉。
    #[test]
    fn new_leaves_existing_data_dir_alone() {
        let fx = Fixture::new("recover_noop");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let leftover = parent.join("ArknightsGameData_old");
        Fixture::write_file(&leftover.join(REVIEW_TABLE_REL), REVIEW_TABLE_JSON);
        Fixture::write_file(&leftover.join("marker.txt"), "previous dataset");

        let relaunched = DataService::new(fx.root.clone());
        assert!(relaunched.is_installed());
        assert!(
            !relaunched.data_dir.join("marker.txt").exists(),
            "现有数据目录不该被残骸覆盖"
        );
        assert!(leftover.exists());
    }

    /// 手动导入的临时 ZIP 在解压失败后也必须删掉——它和数据集一个量级，
    /// 留着只会白占磁盘。
    #[test]
    fn manual_import_temp_zip_is_removed_even_on_failure() {
        let fx = Fixture::new("import_zip_cleanup");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let temp_path = parent.join("ArknightsGameData_import.zip");
        write_zip(&temp_path, &[("pkg/README.md", "no review table")]);

        let err = fx
            .service
            .extract_import_zip(&temp_path, &parent, None)
            .expect_err("无效包必须被拒绝");
        assert!(err.contains("ZIP 校验失败"), "{}", err);
        assert!(!temp_path.exists(), "解压失败后临时导入 ZIP 必须被清理");
        assert!(fx.service.is_installed(), "拒绝无效包不能伤及现有数据");
    }

    #[test]
    fn http_client_builds_with_timeouts() {
        // 冒烟：带超时配置的客户端必须能构建（不发任何请求）。
        DataService::create_http_client().expect("client with timeouts must build");
    }

    #[test]
    fn concurrent_rebuilds_only_build_once() {
        let fx = Fixture::new("index_concurrent");
        let db = fx.service.index_db_path.clone();
        let before = index_build_count(&db);

        let s1 = fx.service.clone();
        let s2 = fx.service.clone();
        let t1 = std::thread::spawn(move || s1.rebuild_story_index());
        let t2 = std::thread::spawn(move || s2.rebuild_story_index());
        t1.join().unwrap().expect("first concurrent rebuild");
        t2.join().unwrap().expect("second concurrent rebuild");

        assert_eq!(
            index_build_count(&db) - before,
            1,
            "并发重建应在 INDEX_BUILD_LOCKS 上串行化，后到的一次靠指纹跳过"
        );

        let status = fx.service.get_story_index_status().unwrap();
        assert!(status.ready);
        assert_eq!(status.total, 6);
    }
}
