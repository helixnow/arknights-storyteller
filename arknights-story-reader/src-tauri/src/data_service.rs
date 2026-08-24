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
    SegmentSearchPage, StoryCategory, StoryEntry, StoryIndexStatus, StoryPreviewToken,
    StorySegment,
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
/// v8 = parser fixes change stored text and speakers: `]` inside quoted
///      attribute values no longer truncates the tag (sticker text used to be
///      dropped or mangled), single-quoted attributes are parsed (speaker
///      names lose stray quotes, e.g. Magallan), and leftover junk after
///      speaker-state commands is no longer indexed as narration.
/// v9 = parser joins trailing-`\` continuation lines back into one logical
///      command before parsing (tutorial/training scripts no longer leak
///      attribute lines as narration, and their text regains its dialogHead
///      speaker), and a lone full-width punctuation mark left after a command
///      (`[Character(...)]。`) is dropped like its ASCII counterpart; both
///      change stored text and shift stored segment indices.
const INDEX_VERSION: i32 = 9;

const META_TOTAL_COUNT: &str = "total_count";
const META_SEGMENT_TOTAL: &str = "segment_total";
/// 建这份索引时数据集的身份（commit + 三张表的大小/mtime + 篇数 + 索引版本）。
/// 对得上就说明索引已经是最新的，重建可以整个跳过。
const META_DATASET_FINGERPRINT: &str = "dataset_fingerprint";
/// 重建进行到一半时数据集被同步/导入换掉的回滚说明。这不是索引库的病：
/// 事务已回滚，重建让给在 `INDEX_BUILD_LOCKS` 上排队的下一次，不清库重试。
const DATASET_SWAPPED_DURING_REBUILD: &str =
    "数据集在索引重建期间被替换，本次结果已回滚，稍后会自动重建";

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

/// Resolve an authoritative total after a query returned exactly its LIMIT.
///
/// `counted = None` means the follow-up COUNT failed. The returned rows are
/// still useful, but claiming `truncated = false` would assert knowledge we
/// do not have, so the boolean records that uncertainty for the caller.
fn resolve_limited_match_total(returned: usize, counted: Option<usize>) -> (usize, bool) {
    match counted {
        Some(total) => (returned.max(total), false),
        None => (returned, true),
    }
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
/// Used to locate preview snippets in raw text (`extract_context*`) and for
/// the segment-search speaker/body badges. 命中判定不走这份文本——它丢掉了
/// token 边界，见 `fts_token_stream`。
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

/// 线性扫描的 haystack：与索引里 `tokenized_content` 完全相同的 token 流，
/// 首尾各垫一个空格，token 之间单空格相隔。匹配判定必须发生在这份文本上
/// 而不是 `normalize_for_fuzzy` 的压平文本上——压平文本丢掉了 token 边界，
/// `contains("prts")` 会命中 `superprts` 的腹部、`contains("0")` 会命中
/// `10` 的个位，而 FTS 的 `prts*`/`0*` 只认「以它开头的 token」；反过来，
/// 压平文本保留假名而分词器丢假名，短语 `"凯尔"` 在 `凯あ尔` 上索引能命
/// 中、压平文本却断开。任何一边独有的命中都是「索引建好前后结果集分叉」。
fn fts_token_stream(text: &str) -> String {
    format!(" {} ", DataService::build_tokenized_content(text))
}

/// 一个查询词。命中方式与它在 FTS 查询里生成的子句一一对应，判定发生在
/// `fts_token_stream` 产出的 token 流上：
///
/// * 普通词 `凯尔希` → FTS `("凯" AND "尔" AND "希")`：每个 CJK 原子必须
///   作为完整 token 出现（任意位置、不要求相邻）；ASCII 原子对应 `run*`，
///   要求存在**以它开头**的 token。
/// * 引号短语 `"凯尔希"` → FTS `"凯 尔 希"`：原子序列必须作为连续 token
///   原样出现（ASCII 原子此时也是精确 token，FTS 短语里没有前缀星号）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TermKind {
    Word,
    Phrase,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Term {
    /// 归一化后的完整词，用来给预览片段定位。
    text: String,
    kind: TermKind,
    atoms: Vec<String>,
}

impl Term {
    /// `source` 是归一化（NFKC + 小写 + 去组合符）后、但**保留**标点和空白
    /// 边界的原词；`text` 已过 `normalize_for_fuzzy`，只用于预览定位。
    ///
    /// 原子必须切在 `source` 上：FTS 侧 `term_to_clause` 在标点处断词，
    /// `0-1` 生成 `(0* AND 1*)` 两个独立 token。先去标点再切的话，ASCII
    /// 段会隔着标点粘成一个原子（`01`），凭空要求两段连续出现——「0」和
    /// 「1」分居标题与正文的剧情在索引路径能命中、扫描回退却漏掉，索引
    /// 建好前后同一查询的结果集就分叉了。
    ///
    /// 返回 `None` 表示这个词在索引侧同样产生不了任何子句（假名、纯标点
    /// 等），两边一起当它不存在。
    fn word(source: &str, text: String) -> Option<Self> {
        let atoms = split_match_atoms(source);
        (!atoms.is_empty()).then(|| Self {
            text,
            kind: TermKind::Word,
            atoms,
        })
    }

    /// 短语保留原子**序列**：FTS 侧 `quoted_to_clause` 生成的就是这串
    /// token 的按序短语，匹配时要求它们作为连续 token 原样出现。原子来源
    /// 与 `word` 同理取 `source`，`{@nickname}` 之类只在 fuzzy 侧被改写的
    /// 串不会偏离 FTS 子句。
    fn phrase(source: &str, text: String) -> Option<Self> {
        let atoms = split_match_atoms(source);
        (!atoms.is_empty()).then(|| Self {
            text,
            kind: TermKind::Phrase,
            atoms,
        })
    }

    /// `haystacks` 是若干 `fts_token_stream`。FTS 的 `MATCH` 判定是行级的：
    /// `A AND B` 允许 A 命中一列、B 命中另一列，所以普通词的不同原子可以
    /// 落在不同的 haystack 上；短语在 FTS 里必须落在同一列内，这里同样要求
    /// 整个序列出现在同一个 haystack 里。
    fn matches(&self, haystacks: &[&str]) -> bool {
        match self.kind {
            TermKind::Word => self.atoms.iter().all(|atom| {
                // token 流里每个 token 前面都有空格：` atom` 命中「以原子
                // 开头的 token」（≙ FTS `atom*`），` atom ` 命中精确 token
                // （≙ FTS `"字"`）。ASCII 走前缀，CJK 单字走精确。
                let needle = if atom.chars().all(|c| c.is_ascii_alphanumeric()) {
                    format!(" {}", atom)
                } else {
                    format!(" {} ", atom)
                };
                haystacks.iter().any(|hay| hay.contains(needle.as_str()))
            }),
            TermKind::Phrase => {
                let needle = format!(" {} ", self.atoms.join(" "));
                haystacks.iter().any(|hay| hay.contains(needle.as_str()))
            }
        }
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
    /// 预览定位的探针序列：先试**每个**正向词的整词，再退回单个原子。
    ///
    /// 只探首个正向词的话，OR 组命中的是第二个备选（`凯尔希 or 阿米娅`
    /// 搜到只提阿米娅的剧情）时探针全部落空，预览退化成开头片段；整词
    /// 优先跨越所有词，是因为单字原子切出的片段远不如别的词的整词命中
    /// 可读——预览碎字多半就是这么来的。
    fn preview_probes(&self) -> impl Iterator<Item = &str> {
        let whole = self
            .positive
            .iter()
            .flatten()
            .map(|term| term.text.as_str());
        let atoms = self
            .positive
            .iter()
            .flatten()
            .flat_map(|term| term.atoms.iter().map(String::as_str));
        whole.chain(atoms)
    }

    /// Are all positive groups satisfied by at least one of `haystacks`?
    /// `haystacks` must be `fts_token_stream` outputs. Callers must check
    /// `excluded_by` separately — a title-only fast path cannot see the body
    /// text a `-term` might live in.
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
/// into one OR group, a leading `-` (or a bare `not` before the term) marks
/// an exclusion, and a bare `and` is a no-op connective. Returns already
/// fuzzy-normalized terms.
///
/// 解析必须发生在与 `build_fts_query_advanced` 相同的文本上：先对整个查询
/// 做 NFKC + 小写 + 去组合符，再按空白/引号切词。在原始文本上解析的话，
/// 全角减号 `－词`（NFKC 之后才是 `-`）在 FTS 侧是排除、在这里却成了肯定
/// 词，全角引号 `＂`（NFKC 后是 `"`）也只有 FTS 侧认得——索引建好前后
/// 同一查询的语义会分叉甚至反转。
fn split_query_terms(query: &str) -> QueryTerms {
    struct Raw {
        /// `normalize_for_fuzzy` 后的整词，预览定位用。
        text: String,
        /// 归一化但保留标点/空白边界的原词，切原子用（见 `Term::word`）。
        source: String,
        is_not: bool,
        is_quoted: bool,
        /// 整个 token 恰好是裸词 `or`：连接词占位，第二遍改写分组用。
        is_or: bool,
    }

    fn flush_bare(buf: &mut String, terms: &mut Vec<Raw>, pending_not: &mut bool) {
        if buf.is_empty() {
            return;
        }
        let t = std::mem::take(buf);
        // 与 FTS 侧一致：连接词判定发生在去减号之前，所以 `-or`/`-and`/
        // `-not` 是排除对应字面量，`or，`、`(or)` 是普通词，都不是连接词。
        if t == "or" {
            terms.push(Raw {
                text: String::new(),
                source: String::new(),
                is_not: false,
                is_quoted: false,
                is_or: true,
            });
            return;
        }
        // 裸词 `and` 是无操作连接词、`not` 是挂到下一个词上的负向前缀，
        // 与 build_fts_query_advanced 严格同步——否则同一查询在索引可用
        // 与否两种状态下语义分叉（FTS 找 `and*`/`not*` token 几乎必空，
        // 扫描按子串匹配 island/commander 又乱命中）。
        if t == "and" {
            return;
        }
        if t == "not" {
            *pending_not = true;
            return;
        }
        let is_not = t.starts_with('-');
        let content = t.trim_start_matches('-');
        // 纯减号串在 FTS 侧同样不产生词条，它前面的 `or`/`not` 顺延给
        // 下一个词，两边要漂一起漂。
        if content.is_empty() {
            return;
        }
        // 归一化后为空的词（纯标点等）也要保留占位：FTS 侧这种词要到子句
        // 生成阶段才被丢弃，其前面的 `or`/`not` 已随之作废，这里必须同样
        // 消费。消费必须无条件 take——写进 `||` 右侧会被短路：`not -X Y`
        // 里 `-X` 自带减号，`not` 不被它吸收就漂到 Y 上，把正向词反转成
        // 排除词（FTS 侧同一写法，两边一起改）。
        let not_prefix = std::mem::take(pending_not);
        terms.push(Raw {
            text: normalize_for_fuzzy(content),
            source: content.to_string(),
            is_not: is_not || not_prefix,
            is_quoted: false,
            is_or: false,
        });
    }

    fn flush_quoted(buf: &mut String, terms: &mut Vec<Raw>, is_not: bool) {
        let phrase = std::mem::take(buf);
        // 空引号 `""` 在 FTS 侧不产生词条也不消费 `or`；非空短语即使归一化
        // 后为空（如 `"，"`）也要占位，理由同 flush_bare。
        if phrase.is_empty() {
            return;
        }
        terms.push(Raw {
            text: normalize_for_fuzzy(&phrase),
            source: phrase,
            is_not,
            is_quoted: true,
            is_or: false,
        });
    }

    let query = normalize_nfkc_lower_strip_marks(query.trim());
    let mut raw_terms: Vec<Raw> = Vec::new();
    let mut buf = String::new();
    let mut in_quotes = false;
    // `-"凯尔希"` / `not "凯尔希"`：负向标记落在引号之前。孤零零的 `-`
    // 会被 `normalize_for_fuzzy` 抹成空串、`not` 只留下悬挂标记——不在
    // 开引号时收下它们，否定短语会被当成肯定短语，语义正好反过来。
    let mut quote_is_not = false;
    let mut pending_not = false;

    for ch in query.chars() {
        match ch {
            '"' => {
                if in_quotes {
                    in_quotes = false;
                    flush_quoted(&mut buf, &mut raw_terms, quote_is_not);
                    quote_is_not = false;
                } else {
                    // 与 FTS 侧同序：先记减号，再 flush（粘连写法
                    // `not"凯尔希"` 由 flush 转成悬挂标记后一并收下）。
                    // take 同样不能进 `||` 右侧：`not -"X" Y` 里 dash_prefix
                    // 为真会短路掉消费，`not` 漂到 Y 上反转其极性。
                    let dash_prefix = buf == "-";
                    flush_bare(&mut buf, &mut raw_terms, &mut pending_not);
                    let not_prefix = std::mem::take(&mut pending_not);
                    quote_is_not = dash_prefix || not_prefix;
                    in_quotes = true;
                }
            }
            c if c.is_whitespace() && !in_quotes => {
                flush_bare(&mut buf, &mut raw_terms, &mut pending_not);
            }
            _ => buf.push(ch),
        }
    }
    // 引号没闭合时按普通词收尾，和 `build_fts_query_advanced` 一致。
    if in_quotes && quote_is_not {
        buf.insert(0, '-');
    }
    flush_bare(&mut buf, &mut raw_terms, &mut pending_not);

    let mut out = QueryTerms::default();
    let mut pending_or = false;
    for raw in raw_terms {
        // 连接词在 flush 时就按「整个 token 恰好是裸词 or」判定过了；
        // 引号里的 `or` 自然是要搜的字面量。
        if raw.is_or {
            // `or` only connects when there is something on the left to
            // connect to; a leading `or` is just noise.
            pending_or = !out.positive.is_empty();
            continue;
        }
        // `or` 归它后面紧跟的那个词——FTS 侧解析时就把 `prev_was_or` 记到
        // 该词头上并立刻清零。这里必须同样先消费掉：这个词若是否定项、或
        // 切不出任何原子（假名、纯标点等）而被丢弃，`or` 要随它一起消失，
        // 不能漂给再下一个正向词。否则 `A or -B C` 在扫描回退里会变成
        // `(A OR C)`，而索引路径是 `A AND C`，索引建好前后同一查询的结果
        // 集就分叉了。
        let is_or_before = std::mem::take(&mut pending_or);
        let term = if raw.is_quoted {
            Term::phrase(&raw.source, raw.text)
        } else {
            Term::word(&raw.source, raw.text)
        };
        let Some(term) = term else { continue };
        if raw.is_not {
            out.negative.push(term);
            continue;
        }
        if is_or_before {
            if let Some(group) = out.positive.last_mut() {
                group.push(term);
                continue;
            }
        }
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
    /// 安装判定与 `holds_valid_dataset` 同一把尺子：非空 review 表才算装了。
    /// 只看 `exists()` 会把 0 字节的 review 表当成「已安装」——首次安装走
    /// `swap_in_extracted` 的跨设备拷贝回退时断电，正好会留下这么一个刚
    /// 创建还没写入的空表，且首次安装没有 `_old` 可恢复，壳子会一直占着
    /// data_dir。误报的后果全是用户可见的死局：check_update 不催下载、
    /// 前端拿到 true 不弹同步引导、设置页说「本地数据」，而目录加载却因
    /// 解析空 JSON 直接报错，用户没有任何出路。判成「未安装」后一切归位：
    /// 读类命令报 NOT_INSTALLED，前端走首次下载/导入引导。
    pub fn is_installed(&self) -> bool {
        Self::holds_valid_dataset(&self.data_dir)
    }

    /// 返回运行时 character_table.json 路径（若已同步），供 character_table
    /// 模块刷新嵌入映射。
    pub fn character_table_path(&self) -> Option<PathBuf> {
        let p = self
            .data_dir
            .join("zh_CN/gamedata/excel/character_table.json");
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
        // 分块导入半途而废，或已经把 `.part` 转正却在 finalize 校验/解压
        // 前崩溃，都会留下与数据集同量级的临时文件。重启后协议从 offset 0
        // 重开，不会续用任何一个；开机统一清掉。同上，此刻不可能有传输在途。
        service.discard_stale_import_artifacts();
        service
    }

    /// 删除上一次运行遗留的分块暂存和已转正临时 ZIP。后者会出现在
    /// `promote_import_staging` 成功、`finalize_manual_import` 尚未接手时
    /// 进程崩溃的窄窗口；旧实现只清 `.part`，这份几百 MB 的弃单会永久
    /// 占盘，直到用户再次导入。删不掉只记日志，下一轮仍会安全地截断/替换。
    fn discard_stale_import_artifacts(&self) {
        let paths = [self.import_staging_path(), self.import_temp_zip_path()];
        for path in paths.into_iter().flatten() {
            match fs::remove_file(&path) {
                Ok(()) => {
                    eprintln!("[IMPORT] 已清理上次中断的导入临时文件 {:?}", path);
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => {
                    eprintln!("[IMPORT] 清理导入临时文件 {:?} 失败（忽略）: {}", path, err);
                }
            }
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
            PRAGMA busy_timeout = 5000;
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

        // Schema compatibility is exact, not monotonic. A database written
        // by a newer binary may have removed/reordered columns or changed its
        // tokenizer contract; keeping it merely because its version is
        // numerically larger makes this older binary issue SQL against an
        // unknown schema. The index is derived data, so both upgrades and
        // downgrades must recreate it.
        let should_recreate = current_version != INDEX_VERSION;

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
        [
            "storyPic",
            "storyEntryPicId",
            "storyPicId",
            "storyMainPicId",
        ]
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
    //   * NOT: leading `-` on a term, or a bare `not` before it
    //   * OR: literal `or` token between terms
    //   * AND: implicit between terms; a bare `and` token is a no-op connective
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
        // 裸词 `not` 是挂到下一个词上的负向前缀（`not X` ≡ `-X`），裸词
        // `and` 是无操作连接词（词间本就隐式 AND）。不这么认的话，
        // `凯尔希 AND 博士` 会被要求正文出现 `and*` 前缀 token、
        // `凯尔希 NOT 博士` 会去找 `not*`——中文语料里几乎不存在，整句
        // 静默变成空结果；回退扫描却按子串匹配 `and`（island、commander
        // 都命中），索引建好前后同一查询「有/无」互相矛盾。前端（高亮、
        // 防抖）一直把 or/and/not 一律当连接词，这里必须对齐。
        let mut prev_was_not = false;
        let flush_bare = |buf: &mut String,
                          terms: &mut Vec<UserTerm>,
                          prev_was_or: &mut bool,
                          prev_was_not: &mut bool| {
            if buf.is_empty() {
                return;
            }
            let t = std::mem::take(buf);
            // 连接词判定发生在去减号之前：`-or` / `-and` / `-not` 是排除
            // 对应字面量的普通词；引号里的写法根本不进这里。
            if t == "or" {
                *prev_was_or = true;
                return;
            }
            if t == "and" {
                return;
            }
            if t == "not" {
                *prev_was_not = true;
                return;
            }
            let is_not = t.starts_with('-');
            let content = if is_not {
                t.trim_start_matches('-').to_string()
            } else {
                t
            };
            if !content.is_empty() {
                // 悬挂的 `not` 只被真正成词的 token 消费；纯减号串跟
                // `or` 一样让它顺延给下一个词。消费必须无条件 take——
                // 写进 `||` 右侧会被短路：`not -X Y` 里 `-X` 自带减号，
                // `not` 不被它吸收就漂到 Y 上，把正向词反转成排除词
                // （split_query_terms 同一写法，两边一起改）。
                let not_prefix = std::mem::take(prev_was_not);
                terms.push(UserTerm {
                    text: content,
                    is_not: is_not || not_prefix,
                    is_or_before: *prev_was_or,
                    is_quoted: false,
                });
                *prev_was_or = false;
            }
        };

        // `-"凯尔希"` / `not "凯尔希"`：负向标记落在引号之前。孤零零的
        // `-` 会被 `flush_bare` 丢掉、`not` 只留下悬挂标记——不在开引号时
        // 收下它们，否定短语会变成肯定短语，语义正好反过来。
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
                        // 先记减号，再 flush（顺带处理粘连写法 `not"凯尔希"`
                        // ——flush 会把 buf 里的 `not` 变成悬挂标记）。
                        // take 同样不能进 `||` 右侧：`not -"X" Y` 里
                        // dash_prefix 为真会短路掉消费，`not` 漂到 Y 上
                        // 反转其极性。
                        let dash_prefix = buf == "-";
                        flush_bare(&mut buf, &mut terms, &mut prev_was_or, &mut prev_was_not);
                        let not_prefix = std::mem::take(&mut prev_was_not);
                        quote_is_not = dash_prefix || not_prefix;
                        in_quotes = true;
                    }
                }
                c if c.is_whitespace() && !in_quotes => {
                    flush_bare(&mut buf, &mut terms, &mut prev_was_or, &mut prev_was_not);
                }
                _ => buf.push(ch),
            }
        }
        // 引号没闭合：剩下的部分退化成普通词，但否定语义要保住。
        if in_quotes && quote_is_not {
            buf.insert(0, '-');
        }
        flush_bare(&mut buf, &mut terms, &mut prev_was_or, &mut prev_was_not);
        if terms.is_empty() {
            return None;
        }

        fn is_fts_special(c: char) -> bool {
            matches!(c, '"' | '*' | ':' | '(' | ')' | '+' | '-' | '^' | '\\')
        }

        fn sanitize(s: &str) -> String {
            s.chars()
                .map(|c| {
                    if is_fts_special(c) || c.is_control() {
                        ' '
                    } else {
                        c
                    }
                })
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
            if s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c.is_whitespace())
            {
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

    /// 失忆索引探针。FTS5 把内容和倒排索引存在不同的影子表里（`*_content`
    /// 与 `*_data`），坏块只吃掉 `*_data` 的页内数据时，全零的结构记录会被
    /// 解码成「合法的空索引」：schema、COUNT、MATCH 全都不报错，只是查什么
    /// 都静默返回空集。COUNT 走 `*_content`（行数照旧），MATCH 走 `*_data`
    /// （空空如也），两边各自「没错」，合起来就是一张有内容却搜不到任何
    /// 东西的索引——比会报错的坏库更隐蔽。
    ///
    /// 取证方式：从内容里取第一行 `token_col` 的第一个 token 反查。该 token
    /// 必然被这一行索引过（`tokenized_*` 列本身就是入索引的 token 流，建库
    /// 时就滤掉了空流），MATCH 查不到它就说明倒排索引已经不认识自己的内容。
    /// token 只可能是 ASCII 字母数字段或单个 CJK 字符（见 `tokenize_for_fts`），
    /// 直接包进 FTS 短语引号是安全的。
    ///
    /// 空表没有可反查的证据，按健康论——ready 与否由行数那头说话；取样或
    /// 反查本身报错（vtable 构造失败等）同样算失忆，那是另一形态的同一种病。
    fn fts_index_recalls_its_content(conn: &Connection, table: &str, token_col: &str) -> bool {
        let sample = match conn
            .query_row(
                &format!("SELECT {} FROM {} LIMIT 1", token_col, table),
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
        {
            Ok(Some(text)) => text,
            Ok(None) => return true,
            Err(_) => return false,
        };
        let Some(token) = sample.split_whitespace().next() else {
            // 建库时就不会写入空 token 流；真遇到只能弃证，交回行数判定。
            return true;
        };
        conn.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM {t} WHERE {t} MATCH ?1)",
                t = table
            ),
            params![format!("\"{}\"", token)],
            |row| row.get::<_, i64>(0),
        )
        .map(|found| found != 0)
        .unwrap_or(false)
    }

    /// 两张 FTS 表的失忆探针合并版：任意一张查不到自己的内容，整份索引就
    /// 不能再被当成「可用/最新」。
    fn index_recalls_its_content(conn: &Connection) -> bool {
        Self::fts_index_recalls_its_content(conn, "story_index", "tokenized_content")
            && Self::fts_index_recalls_its_content(conn, "story_segment_index", "tokenized_text")
    }

    fn index_build_lock(&self) -> Arc<Mutex<()>> {
        let mut guard = INDEX_BUILD_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
        let map = guard.get_or_insert_with(HashMap::new);
        Arc::clone(
            map.entry(self.index_db_path.clone())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    /// 当前数据集的低成本身份：索引版本、包版本及三张目录表的大小/mtime。
    /// 不读数 MB 的 JSON，更不遍历脚本文件，因此可用于每次检索前的陈旧检查。
    fn index_dataset_identity(&self) -> String {
        let fp = self.catalog_fingerprint();
        let files = fp
            .files
            .iter()
            .map(|(len, modified)| format!("{}:{}", len, modified))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "v{}|{}|{}|{}",
            INDEX_VERSION, fp.commit, fp.fetched_at, files
        )
    }

    /// 把数据集身份与目录篇数压成一行文本存进索引元数据。任一项对不上都
    /// 必须重建。格式保持不变；`INDEX_VERSION` 仍为 9。
    fn index_dataset_fingerprint(&self, story_count: usize) -> String {
        format!("{}|{}", self.index_dataset_identity(), story_count)
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
        // 行数对得上不代表倒排索引还认识这些行：坏块把 `*_data` 抹成零后
        // MATCH 静默返回空集而 COUNT（走 `*_content`）照旧。这里若认成
        // 「已是最新」，「重建索引」按钮和同步后排队的自动重建都会直接
        // 跳过，失忆索引从此常驻——与 75455a8 治过的写入死局同病异形。
        if !Self::index_recalls_its_content(conn) {
            return None;
        }
        Some((stories as usize, segments as usize))
    }

    /// Read paths must never migrate the schema. In particular, calling
    /// `init_index_tables` from a status/search request could turn a harmless
    /// version mismatch into DROP/CREATE work and then surface SQLITE_BUSY
    /// while a rebuild transaction was in flight. Only the rebuild path may
    /// migrate; readers treat every missing, malformed, older, or newer
    /// version as unavailable.
    fn index_schema_is_current(conn: &Connection) -> bool {
        Self::extract_meta_value(conn, "index_version")
            .ok()
            .flatten()
            .and_then(|value| value.parse::<i32>().ok())
            == Some(INDEX_VERSION)
    }

    /// 读路径使用的完整可用性判定。重建路径手里有解析后的篇数，可以直接
    /// 用完整 fingerprint；搜索/状态不该为此冷启动解析整张目录表，故拆掉
    /// fingerprint 最后一个 `|篇数`，用其余身份与当前包精确比较，再复用
    /// `index_current_totals` 校验元数据行数、实际行数及失忆探针。
    fn current_dataset_index_totals(&self, conn: &Connection) -> Option<(usize, usize)> {
        if !Self::index_schema_is_current(conn) {
            return None;
        }
        let stored = Self::extract_meta_value(conn, META_DATASET_FINGERPRINT).ok()??;
        let (stored_identity, _) = stored.rsplit_once('|')?;
        if stored_identity != self.index_dataset_identity() {
            return None;
        }
        Self::index_current_totals(conn, &stored)
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
                emit_progress(
                    &index_app,
                    "索引",
                    1,
                    1,
                    "索引重建失败，可稍后在设置中手动重试",
                );
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
            Ok(format!(
                "{} ({})",
                short_commit(&info.commit),
                format_timestamp(info.fetched_at)
            ))
        } else if self.is_installed() {
            // version.json 读不出来 ≠ 没有数据：断电可能把它截成半截，换入
            // 成功后写版本文件也可能失败（sync_data 里版本写在换入之后），
            // 数据集其实还完整躺在 data_dir 里——和 check_update 堵住的是
            // 同一类撒谎。这里若报「未安装」，设置页会把完整数据当成没装、
            // 催用户首次下载。文案必须避开「未安装」，前端拿它判定安装状态。
            Ok("本地数据（版本未知）".to_string())
        } else {
            // 数据集真的不存在，才是「未安装」。
            Ok("未安装".to_string())
        }
    }

    pub fn get_remote_version(&self) -> Result<String, String> {
        let client = Self::create_http_client()?;
        match self.fetch_latest_commit(&client) {
            Ok(commit) => Ok(short_commit(&commit).to_string()),
            Err(_) => Ok("未知".to_string()),
        }
    }

    pub fn check_update(&self) -> Result<bool, String> {
        let Some(current) = self.read_version() else {
            // version.json 读不出来 ≠ 没有数据：断电可能把它截成半截，
            // 换入成功后写版本文件也可能失败（sync_data 里版本写在换入
            // 之后），数据集其实还完整躺在 data_dir 里。这些状态和
            // manual- 一样没有可比 commit，报「有更新」会让用户每次启动
            // 都被催同步；只有数据集真的不存在才提示下载。
            return Ok(!self.is_installed());
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
        let streamed = (|| -> Result<(), String> {
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
                .map_err(|e| format!("Failed to flush zip file: {}", e))
        })();
        // 半截 ZIP 是纯垃圾：断流/磁盘满时留着只会白占几百 MB（重试本就
        // 整包重下、原地截断重写），用户放弃重试的话它就永远赖在磁盘上。
        // 先关句柄再删——Windows 上删不掉还打开着的文件。
        drop(zip_file);
        if let Err(err) = streamed {
            fs::remove_file(&zip_path).ok();
            return Err(err);
        }

        emit_progress(app, "下载", 100, 100, "下载完成");
        let extracted = self.extract_zip_at(&zip_path, parent_dir, Some(app));
        // 与手动导入的 extract_import_zip 同一取舍：解压无论成败，下载包都
        // 已用完。失败时它多半是个坏包，留着既占磁盘也不能续用。
        fs::remove_file(&zip_path).ok();
        extracted
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

        let result = self.extract_zip_into(zip_path, &extract_root, app);

        // 解压暂存树无论成败都不能留。失败时（坏包、解压中途 IO 错误、
        // 换入失败）它是上百 MB 的半截垃圾，本来要等下一次同步开场才被
        // 清理——用户放弃重试就永远占着磁盘；最常见的失败原因又恰是磁盘
        // 满，残骸还会反过来堵死腾空间后的恢复余地。成功时数据集本体已
        // 换进 data_dir，这里剩下的只是 __MACOSX 之类的包装残渣；数据集
        // 根恰好是解压根且已被改名换走时目录已不存在，删除失败忽略即可。
        fs::remove_dir_all(&extract_root).ok();
        result?;

        // 数据目录已经整个换掉，缓存的剧情目录立刻作废。
        self.invalidate_catalog();
        Ok(())
    }

    /// `extract_zip_at` 的主体：解压到已备好的空 `extract_root`，校验、
    /// 剪枝并换入。拆出来是为了让调用方能在任何失败路径上统一清理
    /// 暂存树（本方法内部的 `?` 提前返回不再各自负责收拾现场）。
    fn extract_zip_into(
        &self,
        zip_path: &Path,
        extract_root: &Path,
        app: Option<&AppHandle>,
    ) -> Result<(), String> {
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

        // 定位数据集根不能盲选第一个子目录：macOS 打出来的包常带
        // __MACOSX 伴生目录，有的包则把 zh_CN 直接放在压缩包根部（此时
        // 根本没有「顶层目录」可选）。非空 review 表只够筛候选，不够验收：
        // 非空但截断的 JSON、或只有目录表没有任何脚本的包都不能替掉旧数据。
        //
        // 候选顺序固定：压缩包根优先，其余顶层目录按路径排序。read_dir 的
        // 文件系统顺序不稳定，若包里意外有两棵候选树，不能每次随机换一棵。
        let mut candidates = Vec::new();
        if Self::holds_valid_dataset(extract_root) {
            candidates.push(extract_root.to_path_buf());
        }
        let mut child_candidates: Vec<PathBuf> = fs::read_dir(extract_root)
            .map_err(|e| format!("Failed to read extracted directory: {}", e))?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.is_dir() && Self::holds_valid_dataset(path))
            .collect();
        child_candidates.sort();
        candidates.extend(child_candidates);

        let mut rejection = format!("缺少或为空 {}", REVIEW_TABLE_REL);
        let mut extracted_root = None;
        for candidate in candidates {
            match Self::validate_dataset_for_install(&candidate) {
                Ok(()) => {
                    extracted_root = Some(candidate);
                    break;
                }
                Err(err) => rejection = err,
            }
        }
        let extracted_root =
            extracted_root.ok_or_else(|| format!("ZIP 校验失败：{}，已保留原有数据", rejection))?;

        // 阅读器只需要 story / excel 数据；关卡、战斗、美术等目录加起来
        // 是数据集的大头，移动前先剪掉，省磁盘也省一次拷贝。
        Self::prune_unused_dirs(&extracted_root);

        self.swap_in_extracted(&extracted_root)
    }

    /// 旧数据在换入期间的暂存目录（`<data_dir>_old`）。上一次换入若在
    /// 「挪开旧目录」和「删掉暂存」之间崩溃会留下残骸：能清就清掉复用
    /// 固定名字；清不掉就退化成带时间戳的名字，绝不往已有目录上改名。
    ///
    /// 例外：固定名残骸装着**有效数据集**而 `data_dir` 只是壳子时，它不是
    /// 陈骸，而是唯一完整副本——跨设备拷贝断电或回滚半途而废都会造出
    /// 这个局面（启动恢复清壳失败、或同进程内直接重试同步时根本没有
    /// 启动恢复兜底），此刻新树还没落位、随时可能落不了位（磁盘满正是
    /// 换入失败最常见的诱因），先删 `_old` 等于把恢复来源和新数据一起
    /// 押上赌桌。此时保留固定名不碰，直接退化用时间戳名字给壳子腾位；
    /// 换入成功后 `data_dir` 重新有效，这份 `_old` 才降格为陈骸，由下一
    /// 次换入照常回收。与 `restore_data_dir_from_aside` 的目录不变量同一
    /// 把尺子：手里没握着有效数据集之前，绝不销毁最后一份有效数据。
    fn old_data_aside_path(&self) -> PathBuf {
        let mut name = self
            .data_dir
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_else(|| std::ffi::OsString::from("ArknightsGameData"));
        name.push("_old");
        let fixed = self.data_dir.with_file_name(&name);
        let fixed_is_recovery_source =
            Self::holds_valid_dataset(&fixed) && !Self::holds_valid_dataset(&self.data_dir);
        if !fixed_is_recovery_source && (!fixed.exists() || fs::remove_dir_all(&fixed).is_ok()) {
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
    /// 撑得起应用的数据集。解压后选根、换入验收和崩溃恢复用同一把尺子。
    fn holds_valid_dataset(dir: &Path) -> bool {
        fs::metadata(dir.join(REVIEW_TABLE_REL))
            .map(|meta| meta.is_file() && meta.len() > 0)
            .unwrap_or(false)
    }

    /// 安装前的强校验。`holds_valid_dataset` 是每次状态查询都会走的廉价
    /// stat，不能在那里解析数 MB JSON；解压换包是低频路径，必须在旧数据
    /// 还未挪开时确认目录表可解析、至少有一个完整条目，并且至少一篇对应
    /// 脚本真实存在且非空。否则一个非空的半截 JSON 或“只有 excel 没有
    /// story”的残包会通过旧验收，原子地把可用数据替换成不可用数据。
    fn validate_dataset_for_install(dir: &Path) -> Result<(), String> {
        let review_path = dir.join(REVIEW_TABLE_REL);
        let content = fs::read_to_string(&review_path)
            .map_err(|err| format!("无法读取 {}: {}", REVIEW_TABLE_REL, err))?;
        let data: HashMap<String, Value> = serde_json::from_str(&content)
            .map_err(|err| format!("{} 不是完整 JSON: {}", REVIEW_TABLE_REL, err))?;
        if data.is_empty() {
            return Err(format!("{} 没有剧情分组", REVIEW_TABLE_REL));
        }

        let stories: Vec<StoryEntry> = data
            .values()
            .flat_map(Self::parse_group_entries)
            .filter(|story| !story.story_id.trim().is_empty() && !story.story_txt.trim().is_empty())
            .collect();
        if stories.is_empty() {
            return Err(format!("{} 没有可用剧情条目", REVIEW_TABLE_REL));
        }

        let story_root = dir.join("zh_CN/gamedata/story");
        let has_readable_script = stories.iter().any(|story| {
            fs::metadata(story_root.join(format!("{}.txt", story.story_txt)))
                .map(|meta| meta.is_file() && meta.len() > 0)
                .unwrap_or(false)
        });
        if !has_readable_script {
            return Err("剧情目录缺少与目录表对应的非空脚本".to_string());
        }
        Ok(())
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
    /// 启用，必然比固定名新。
    ///
    /// 目录不变量：`data_dir` 装着**有效数据集**时绝不动它——成功换入后
    /// 清理失败留下的 `_old` 是上一份数据，抢着恢复反而会顶掉新数据。
    /// 判定用 `holds_valid_dataset` 而不是 `exists`：`swap_in_extracted`
    /// 的跨设备回退拷贝（`copy_dir_all` 分支）中途断电会留下一个没有
    /// review 表的半截新树占住 `data_dir`，完整旧数据还躺在 `_old` 里。
    /// 只认「目录存在」的话这份旧数据永远接不回来，还会在下一次换入
    /// 开场被 `old_data_aside_path` 当陈骸删掉——离线用户就此丢失唯一
    /// 完整副本。壳子撑不起应用，必须让位；且只有手里握着有效暂存时
    /// 才清壳子，没有恢复来源时 `data_dir` 一个字节都不碰。
    /// 本方法只在 `DataService::new`（setup，单线程）里跑，动这些目录
    /// 没有并发之忧。
    fn restore_data_dir_from_aside(&self) {
        if Self::holds_valid_dataset(&self.data_dir) {
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

        // 走到这里说明 data_dir 要么不存在，要么是撑不起应用的半截壳子
        // （见上：跨设备拷贝断电）。rename 不能覆盖非空目录，先把壳子
        // 清掉。删不掉就保持现状：旧数据仍完整躺在暂存目录里，下次启动
        // 重试——绝不能反过来先动暂存目录。
        if self.data_dir.exists() {
            if let Err(err) = fs::remove_dir_all(&self.data_dir) {
                eprintln!(
                    "[RECOVER] 发现无效的数据目录残骸 {:?}，但清理失败（{}），本次不恢复；旧数据仍完整保留在 {:?}",
                    self.data_dir, err, aside
                );
                return;
            }
            eprintln!(
                "[RECOVER] 已清除换入中断留下的无效数据目录残骸 {:?}",
                self.data_dir
            );
        }

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
                    // 挪不开（Windows 上目录被占用、父目录临时只读等）时
                    // 绝不能退回递归删除：remove_dir_all 可能先删光目录里的
                    // 大部分文件，最后才因某个占用文件或根目录权限报错。此
                    // 时既没有 `_old` 可回滚，原数据也已被掏空。新树尚未动，
                    // 直接失败让用户重试，旧数据一个字节都不碰。
                    return Err(format!(
                        "Failed to preserve old data directory before replacement: {}",
                        err
                    ));
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
                emit_progress(
                    &index_app,
                    "索引",
                    1,
                    1,
                    "索引重建失败，可稍后在设置中手动重试",
                );
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

        let temp_path = self.import_temp_zip_path()?;
        emit_progress(&app, "导入", 0, 100, "正在复制 ZIP 文件");
        if let Err(e) = fs::copy(source_path, &temp_path) {
            // 复制中途失败（典型是磁盘满）会留下半截临时 ZIP；它和数据集
            // 一个量级，没人会再用它，必须立刻删掉，别让残骸把本就不够的
            // 磁盘占得更死。
            fs::remove_file(&temp_path).ok();
            return Err(format!("复制 ZIP 文件失败: {}", e));
        }

        emit_progress(&app, "导入", 30, 100, "正在校验 ZIP 文件");
        self.finalize_manual_import(&temp_path, &app)
    }

    /// 分块导入的暂存文件路径。放在导入临时 ZIP 同一个目录里，收尾改名
    /// 时保证不跨文件系统；`.part` 后缀表明它随时可能是半截文件。半途
    /// 而废的暂存运行期不必专门清理——下一轮传输的首块会原地截断重
    /// 写；跨次启动的残留由 `discard_stale_import_artifacts` 在开机时删掉。
    pub fn import_staging_path(&self) -> Result<PathBuf, String> {
        let parent_dir = self
            .data_dir
            .parent()
            .ok_or_else(|| "Invalid data directory".to_string())?;
        Ok(parent_dir.join("ArknightsGameData_import_staging.part"))
    }

    /// 导入临时 ZIP 的固定路径。`import_zip_from_path` 复制到这里，分块
    /// 导入的收尾把暂存文件改名到这里。文件名只在本方法出现一次，
    /// 保证改名的目标与 finalize 读取的来源永远是同一个文件。
    pub fn import_temp_zip_path(&self) -> Result<PathBuf, String> {
        let parent_dir = self
            .data_dir
            .parent()
            .ok_or_else(|| "Invalid data directory".to_string())?;
        Ok(parent_dir.join("ArknightsGameData_import.zip"))
    }

    /// 对已经转正（暂存改名成导入临时 ZIP）的文件执行导入。与
    /// `import_zip_from_path` 的差别只在第一步：字节已经躺在导入临时
    /// ZIP 里，无需整包复制，直接走统一的 finalize 流程（校验、解压、
    /// 覆盖、重建索引）。
    ///
    /// 「确认暂存存在 + 改名转正」必须在调用本方法之前、于
    /// IMPORT_CHUNK_LOCK 内完成（见 commands.rs 的
    /// `promote_import_staging`）：若不与追加互斥，滞留在阻塞线程池里
    /// 的迟到块可能插进 exists 与 rename 之间，把字节写进即将转正的
    /// 暂存文件，损坏 ZIP。本方法特意不持那把锁——解压可能要跑几分钟，
    /// 攥着锁会把迟到块本该秒回的「传输中断」快速失败也一起堵住。
    pub fn import_promoted_zip(&self, app: AppHandle) -> Result<(), String> {
        let temp_path = self.import_temp_zip_path()?;
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

        // 直接 `fs::write` 正式文件，断电会把 version.json 截成半截——正是
        // check_update / get_current_version 被迫兜底「版本未知」的根因。改
        // 为先写同目录临时文件、fsync、再 rename：同目录内 rename 替换是原
        // 子的（POSIX 保证；Windows 的 std 用 MOVEFILE_REPLACE_EXISTING），
        // 于是正式文件任何时刻要么是旧的完整内容、要么是新的完整内容。
        // pid+nanos 后缀避免并发/残留同名冲突；同目录也排除了跨设备 rename。
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let tmp_path = self.data_dir.join(format!(
            ".{}.{}.{}.tmp",
            VERSION_FILE,
            std::process::id(),
            nanos
        ));
        let result = (|| -> std::io::Result<()> {
            let mut file = fs::File::create(&tmp_path)?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
            fs::rename(&tmp_path, &path)
        })();
        if let Err(e) = result {
            // 任一步失败都清掉临时文件：半截内容只允许出现在带 .tmp 后缀、
            // read_version 永远不会碰的文件里。
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("Failed to write version info: {}", e));
        }
        Ok(())
    }
}

/// commit 的短显示：取前 7 个「字符」。不能按字节切（`&s[..7]`）——正常
/// commit 是 ASCII hex，但本地 version.json 可被手工编辑、远端 sha 又来自
/// 网络响应，一旦混入多字节 UTF-8 且字节 7 落在字符中间，字节切片会让
/// 整个命令 panic。字符数不足 7 时原样返回，与旧的 ASCII 行为一致。
fn short_commit(commit: &str) -> &str {
    commit
        .char_indices()
        .nth(7)
        .map_or(commit, |(idx, _)| &commit[..idx])
}

/// 格式化时间戳
fn format_timestamp(timestamp: i64) -> String {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    if timestamp <= 0 {
        // 写入方最坏也只写 0；负数只会来自手工编辑的 version.json。负数
        // `as u64` 会回绕成天文数字，加到 EPOCH 上直接溢出 panic。0 走原
        // 逻辑本来也是「较早前」，一并在此短路。
        return "较早前".to_string();
    }

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
                Ok(content) => return Ok(normalize_info_interpolations(&content)),
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
        self.rebuild_story_index_emitting(|phase, cur, total, msg| {
            if let Some(app) = app {
                let progress = IndexProgress {
                    phase: phase.to_string(),
                    current: cur,
                    total,
                    message: msg.to_string(),
                };
                let _ = app.emit("index-progress", progress);
            }
        })
    }

    /// Run a rebuild through one progress sink and guarantee that every error
    /// leaves the consumer in a terminal state. `useAutoIndex` deliberately
    /// keys off the stable phase literal "失败", so callers must not have to
    /// infer failure from a dropped command future or from the last nonterminal
    /// "收集"/"构建" event.
    fn rebuild_story_index_emitting(
        &self,
        emit: impl Fn(&str, usize, usize, &str),
    ) -> Result<(), String> {
        let result = self.rebuild_story_index_attempt(&emit);
        if let Err(err) = &result {
            let message = format!("索引重建失败：{}", err);
            emit("失败", 0, 0, &message);
        }
        result
    }

    fn rebuild_story_index_attempt(
        &self,
        emit: &impl Fn(&str, usize, usize, &str),
    ) -> Result<(), String> {
        if !self.is_installed() {
            return Err("NOT_INSTALLED".to_string());
        }

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

        // 打不开、或建不了表的索引库几乎必然已经损坏（半截写入、坏块，
        // open 时 PRAGMA 就报 "file is not a database"）。搜索路径遇到它
        // 会静默回退线性扫描，但重建在这里直接报错就成了死局：除了整包
        // 重新同步没有任何路径会清掉坏库，「重建索引」按钮从此永远失败。
        // 库里只有派生数据，本来就要从头重建——清掉重开；清理或二次
        // 打开仍失败才把错误抛给调用方。
        let mut conn = match self
            .open_index_connection()
            .and_then(|conn| Self::init_index_tables(&conn).map(|()| conn))
        {
            Ok(conn) => conn,
            Err(err) => {
                eprintln!("[INDEX] 索引库不可用（{}），清空后从头重建", err);
                self.clear_story_index()?;
                let conn = self.open_index_connection()?;
                Self::init_index_tables(&conn)?;
                conn
            }
        };

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

        let (total, segment_total) =
            match self.build_index_once(&mut conn, &catalog, &dataset_probe, &fingerprint, emit) {
                Ok(Some(totals)) => totals,
                Ok(None) => return Err(DATASET_SWAPPED_DURING_REBUILD.to_string()),
                Err(err) => {
                    // 与「打不开 / 建不了表」同一条自愈路的另一半：坏块只落在
                    // FTS 内容页上时，open、建表、甚至剧情表的查询都探不出病，
                    // 损坏要到清表/灌入/提交才第一次暴露（vtable constructor
                    // failed）。不清库的话这里每次都失败在同一处，「重建索引」
                    // 按钮从此永远失败，和当初 open 失败的死局一模一样。库里
                    // 只有派生数据：关连接、清库、重开、从头再试一次；再失败
                    // （磁盘满这类环境问题）才把错误抛给调用方。
                    eprintln!("[INDEX] 索引写入失败（{}），清空索引库后从头重试", err);
                    drop(conn);
                    self.clear_story_index()?;
                    let mut fresh = self.open_index_connection()?;
                    Self::init_index_tables(&fresh)?;
                    match self.build_index_once(
                        &mut fresh,
                        &catalog,
                        &dataset_probe,
                        &fingerprint,
                        emit,
                    )? {
                        Some(totals) => totals,
                        None => return Err(DATASET_SWAPPED_DURING_REBUILD.to_string()),
                    }
                }
            };

        emit(
            "完成",
            total,
            total,
            &format!("已索引 {} 篇 / {} 段", total, segment_total),
        );

        Ok(())
    }

    /// 一次完整的索引构建尝试：清表、灌入、提交前复核数据集身份、写元数据、
    /// 提交。`Ok(None)` 表示数据集在构建期间被同步/导入换掉、事务已按约
    /// 回滚；其余错误都是索引库自身的读写失败，由调用方决定是否清库重试。
    fn build_index_once(
        &self,
        conn: &mut Connection,
        catalog: &StoryCatalog,
        dataset_probe: &CatalogFingerprint,
        fingerprint: &str,
        emit: &impl Fn(&str, usize, usize, &str),
    ) -> Result<Option<(usize, usize)>, String> {
        let indexed_stories = &catalog.stories;

        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start index transaction: {}", e))?;

        tx.execute("DELETE FROM story_index", [])
            .map_err(|e| format!("Failed to clear story index: {}", e))?;
        tx.execute("DELETE FROM story_segment_index", [])
            .map_err(|e| format!("Failed to clear story segment index: {}", e))?;

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
                        StorySegment::Dialogue {
                            character_name,
                            text,
                            ..
                        } => (
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
                            (
                                "image",
                                None,
                                Cow::Borrowed(caption.as_deref().unwrap_or("")),
                            )
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
                emit("构建", idx + 1, indexed_stories.len(), story_name);
            }
        }

        drop(story_insert_stmt);
        drop(segment_insert_stmt);

        // 提交前复核：构建期间数据集被同步/导入换掉的话，上面读到的是新旧
        // 混合的内容，而此刻的磁盘指纹已经是新数据集的。若照常提交，这份
        // 杂交索引会被盖上新指纹，刚结束的那次同步随后自动发起的重建（在
        // `INDEX_BUILD_LOCKS` 上排队）一看指纹相符就直接跳过，坏索引从此
        // 常驻。回滚本次事务，把重建让给排在后面的那一次——这不是索引库
        // 的病，调用方不得清库重试。
        if self.catalog_fingerprint() != *dataset_probe {
            return Ok(None);
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
            (META_DATASET_FINGERPRINT, fingerprint.to_string()),
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

        Ok(Some((total, segment_total)))
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

        // ready 必须同时回答三件事：索引属于当前数据包、两表行数与建库
        // 元数据一致、倒排索引仍认识自己的内容。只看 COUNT + 失忆探针会
        // 把「换包后尚未来得及清掉的旧库」和被截断的库都误报成可用，
        // useAutoIndex 便永远不会触发重建。
        let current_totals = self.current_dataset_index_totals(&conn);
        let index_is_current = current_totals.is_some();
        // A stale pack's row count and build timestamp are no more useful
        // than its hits. Exposing them while ready=false made the status look
        // like a merely unconfirmed current index and leaked leftover-pack
        // metadata to the UI. Only publish totals proven to belong to the
        // installed dataset.
        let total = current_totals.map(|(stories, _)| stories).unwrap_or(0);
        let last_built_at = if index_is_current {
            Self::extract_meta_value(&conn, "last_built_at")
                .ok()
                .flatten()
                .and_then(|value| value.parse::<i64>().ok())
        } else {
            None
        };

        Ok(StoryIndexStatus {
            ready: index_is_current,
            total,
            last_built_at,
        })
    }

    fn search_stories_with_index(&self, query: &str) -> Result<Option<Vec<SearchResult>>, String> {
        let Some(conn) = self.try_open_index_connection()? else {
            return Ok(None);
        };

        // 空表、失忆、行数截断或数据集已换：都不能把 FTS 结果当成当前
        // 语料的权威答案。剧情检索有扫描兜底，明确交回 None。
        if self.current_dataset_index_totals(&conn).is_none() {
            eprintln!("[INDEX] 索引未就绪、损坏或不属于当前数据集，回退线性扫描");
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
            SELECT story_id, story_name, category, raw_content
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
            Ok((story_id, story_name, category, raw_content))
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
        // 兜底定位用：整串探针把空白/标点全部压掉，只有词与词恰好相邻时
        // 才命中；多词 AND、`or`、排除词都会落空，得退回正向词探针。
        let terms = split_query_terms(query);
        let mut results = Vec::new();
        for row in rows {
            if let Ok((story_id, story_name, category, raw_content)) = row {
                // 优先使用原始内容提取上下文，避免 tokenized_content 导致的空格断字
                let mut matched_text = self.extract_context(&raw_content, &context_probe);
                if matched_text.trim().is_empty() {
                    // 以前这里回退 FTS 的 snippet()——那一列是逐字分词文本，
                    // 每个汉字之间都有空格、标点全丢，展示出来是碎的。改走
                    // 线性扫描同一套预览：先整词、再单原子定位，最后给正文
                    // 开头的干净预览，两条路径的片段观感保持一致。
                    matched_text = self.preview_for(&raw_content, &terms);
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
            // 判定一律在 `fts_token_stream` 上做：标题流是 `tokenized_content`
            // 开头那截（`searchable_text` = 标题 + 正文），代码流对应索引里的
            // `story_code` 列（unicode61 同样在 `-` 处断词）。
            let name_stream = fts_token_stream(&story.story_name);
            let code_stream = story
                .story_code
                .as_ref()
                .map(|s| fts_token_stream(s))
                .unwrap_or_default();
            let title_hits = terms.positives_match(&[name_stream.as_str(), code_stream.as_str()]);

            // Fast path: title/code hit and nothing to exclude. With NOT terms
            // in play we still have to read the body, since an exclusion may
            // only appear there.
            let hit = if title_hits && terms.negative.is_empty() {
                // 与索引同一份语料：rebuild 里 read_story_text 失败的剧情
                // 整篇不入库（FTS 搜不到），标题快路径必须做同样的取舍。
                // 否则脚本缺失的条目（残缺手工包）在索引没建好时能凭标题
                // 命中、索引建好后又消失，两条路径的结果集就不一致了；
                // 点开也只会得到读文件错误。读得出来本身就是判定，正文
                // 内容这里用不上。
                //
                // 索引侧还有一条取舍要镜像：tokenized 全文为空的剧情整篇
                // 不入库，storyCode 随之不可搜。标题流有 token 时全文流
                // 必然非空（标题 ⊆ 全文），读得出来即可；标题流为空、
                // 命中全靠 storyCode 时必须真的解析正文，确认这篇在索引
                // 里存在——否则这类剧情只在索引建好前能凭 code 命中。
                if !name_stream.trim().is_empty() {
                    self.read_story_text(&story.story_txt)
                        .is_ok()
                        .then(|| story.story_name.clone())
                } else {
                    self.story_searchable_text(&story.story_name, &story.story_txt)
                        .filter(|content| !Self::build_tokenized_content(content).trim().is_empty())
                        .map(|_| story.story_name.clone())
                }
            } else {
                // 扫的是「标题 + 解析后的正文」，也就是索引里 `raw_content`
                // 的同一份文本。直接扫原始脚本的话，`[name=...]`、素材 token
                // 之类的指令文字只在这条路径上能被搜到，索引建好之后同一个
                // 查询就突然搜不到了。
                self.story_searchable_text(&story.story_name, &story.story_txt)
                    .and_then(|content| {
                        // 与索引里 `tokenized_content` 逐 token 相同的流。
                        let content_stream = fts_token_stream(&content);
                        // tokenized 全文为空的剧情在 rebuild 里整篇跳过
                        // （不入 FTS 库），这里必须同样跳过——否则命中全靠
                        // story_code 的这类剧情只在索引建好前可见。
                        if content_stream.trim().is_empty() {
                            return None;
                        }
                        let haystacks = [content_stream.as_str(), code_stream.as_str()];
                        if terms.excluded_by(&haystacks) {
                            return None;
                        }
                        if !title_hits && !terms.positives_match(&haystacks) {
                            return None;
                        }
                        Some(if title_hits {
                            story.story_name.clone()
                        } else {
                            self.preview_for(&content, &terms)
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

    /// 命中片段：先按正向词的整词定位（所有词都试——OR 组命中的可能是
    /// 第二个备选），不行再退回单个原子，最后给一段开头预览。
    /// 空字符串对用户毫无意义，任何情况下都要给点上下文。
    fn preview_for(&self, content: &str, terms: &QueryTerms) -> String {
        let snippet = self.extract_context_any(content, terms.preview_probes());
        if !snippet.trim().is_empty() {
            return snippet;
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
        self.search_stories_with_source(query)
            .map(|(results, _index_used)| results)
    }

    /// Internal story search result plus provenance. `index_used` is true
    /// only when `search_stories_with_index` returned an authoritative FTS
    /// result set; every scanner/error/empty-query path is false.
    fn search_stories_with_source(&self, query: &str) -> Result<(Vec<SearchResult>, bool), String> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok((Vec::new(), false));
        }

        match self.search_stories_with_index(trimmed) {
            // Index returned authoritative results — don't waste time on
            // linear scan. Char-level FTS5 is a superset of plain contains()
            // matching at this point.
            Ok(Some(results)) => Ok((results, Self::build_fts_query_advanced(trimmed).is_some())),
            // Index not ready (never built, was cleared, or empty table).
            // Fall through to the slower scanner so the user can still get
            // *something* on first launch. The scanner caps at
            // SEARCH_RESULT_LIMIT and doesn't attempt to enumerate every
            // story — practical budget is single-digit seconds on a typical
            // machine.
            Ok(None) => self
                .search_stories_fallback(trimmed)
                .map(|results| (results, false)),
            Err(err) => {
                eprintln!(
                    "[INDEX] Failed to search using index ({}), fallback to linear scan",
                    err
                );
                self.search_stories_fallback(trimmed)
                    .map(|results| (results, false))
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
                index_used: false,
            });
        }

        // `total = 0` 是与前端约定的「不确定态」：还不知道要走索引还是扫全库，
        // 报一个 0/3 只是编出来的百分比。真实分母由线性扫描那一步给出。
        progress("检索", 0, 0, format!("搜索「{}」", trimmed));
        let (results, index_used) = self.search_stories_emitting(app, trimmed)?;

        // Compute total via FTS (best effort — if the index is unavailable we
        // fall back to `results.len()` which is at least a lower bound).
        progress("统计", 0, 0, format!("命中 {} 篇，正在统计", results.len()));
        let counted = if index_used {
            self.count_fts_matches(trimmed).unwrap_or(None)
        } else {
            None
        };
        let (total_matched, truncated) = match counted {
            // 索引给出了权威总数：截断与否就看有没有没返回的命中。
            Some(count) => {
                let total = count.max(results.len());
                (total, total > results.len())
            }
            // 只有线性扫描的结果可依据。扫描在攒满 SEARCH_RESULT_LIMIT 条时
            // 提前收针，此时真实总数未知但至少等于上限——必须承认截断，
            // 而不是把「已返回条数」当成总数宣称一条不少。
            None => (results.len(), results.len() >= SEARCH_RESULT_LIMIT),
        };
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
            truncated,
            facets,
            index_used,
        })
    }

    /// FTS 侧的命中总数。`Ok(None)` 表示索引给不出权威数字——没建好、表还
    /// 是空的、或 MATCH 本身报错。这些情形下检索走的都是线性扫描，把 0 当
    /// 总数上报会被 `max(results.len())` 悄悄抹平成「恰好等于已返回条数」，
    /// 扫描在命中上限提前收针时就谎报成「没截断」。
    fn count_fts_matches(&self, query: &str) -> Result<Option<usize>, String> {
        let Some(conn) = self.try_open_index_connection()? else {
            return Ok(None);
        };
        // 与 `search_stories_with_index` 同一把尺子：空表、失忆、行数截断或
        // 数据集已换时检索走的是扫描，这里的 MATCH COUNT 没有权威性。
        // 尤其旧索引报出的 0 会被 `max(results.len())` 抹成「恰好没截断」。
        if self.current_dataset_index_totals(&conn).is_none() {
            return Ok(None);
        }
        let Some(fts_query) = Self::build_fts_query_advanced(query) else {
            // 纯否定/纯标点查询：索引路径同样明确返回空集，0 是权威的。
            return Ok(Some(0));
        };
        match conn.query_row(
            "SELECT COUNT(*) FROM story_index WHERE story_index MATCH ?1",
            params![fts_query],
            |row| row.get::<_, i64>(0),
        ) {
            Ok(total) => Ok(Some(total.max(0) as usize)),
            Err(err) => {
                // MATCH 报错时检索路径也已回退扫描，别把错误伪装成 0。
                eprintln!("[INDEX] count failed for '{}': {}", fts_query, err);
                Ok(None)
            }
        }
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
                index_used: false,
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
                index_used: false,
            });
        };

        // 段落检索没有线性扫描兜底，因此只能接受属于当前数据集、两表行数
        // 完整且倒排索引仍能反查自身内容的索引。换包后残留的旧库尤其危险：
        // 它会返回看似正常、实际已经不属于当前语料的旧段落。
        let Some((_, seg_total)) = self.current_dataset_index_totals(&conn) else {
            eprintln!("[SEG-INDEX] 段落索引未就绪、损坏或不属于当前数据集");
            progress("完成", 1, 1, "段落索引不可用".to_string());
            return Ok(SegmentSearchPage {
                hits: Vec::new(),
                total_matched: 0,
                truncated: false,
                index_used: false,
            });
        };

        // Bail out if this valid index genuinely has no searchable segments.
        if seg_total == 0 {
            progress("完成", 1, 1, "段落索引为空".to_string());
            return Ok(SegmentSearchPage {
                hits: Vec::new(),
                total_matched: 0,
                truncated: false,
                index_used: false,
            });
        }

        let Some(fts_query) = Self::build_fts_query_advanced(trimmed) else {
            progress("完成", 1, 1, "查询没有可用的正向词".to_string());
            return Ok(SegmentSearchPage {
                hits: Vec::new(),
                total_matched: 0,
                truncated: false,
                index_used: false,
            });
        };

        // bm25 column weights: story_id(UNINDEXED)=0, segment_index(UNINDEXED)=0,
        // segment_type(UNINDEXED)=0, character_name=6, tokenized_text=1,
        // raw_text(UNINDEXED)=0. Boost character name matches so searching an
        // operator floats dialogue hits featuring that operator to the top.
        // 不取 snippet()：那一列是逐字分词文本（汉字间全是空格、标点全丢），
        // 切出来的片段是碎的，预览早已改走 raw_text；留着它每行都白算一次。
        let query_sql = format!(
            "
            SELECT s.story_id,
                   s.segment_index,
                   s.segment_type,
                   s.character_name,
                   s.raw_text
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
                    index_used: false,
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
            Ok((
                story_id,
                segment_index,
                segment_type,
                character_name,
                raw_text,
            ))
        }) {
            Ok(r) => r,
            Err(err) => {
                eprintln!("[SEG-INDEX] query failed for '{}': {}", fts_query, err);
                progress("完成", 1, 1, "段落检索失败".to_string());
                return Ok(SegmentSearchPage {
                    hits: Vec::new(),
                    total_matched: 0,
                    truncated: false,
                    index_used: false,
                });
            }
        };

        // 预览定位用：多词查询的整串探针几乎必落空（词与词很少恰好相邻），
        // 逐词探针能把片段对准真正命中的那个词，而不是裁一段开头了事。
        let terms = split_query_terms(trimmed);
        let context_probe = normalize_for_fuzzy(trimmed);
        let mut hits: Vec<SegmentHit> = Vec::new();
        let mut seen: std::collections::HashSet<(String, usize)> = Default::default();
        for row in rows {
            let Ok((story_id, segment_index, segment_type, character_norm, raw_text)) = row else {
                continue;
            };
            // Classify the column with the same token/prefix/phrase/boolean
            // semantics that selected this FTS row. Flattened substring
            // probes cannot understand `A OR B`, bare AND/NOT, ASCII
            // prefixes, or token boundaries and therefore mislabeled those
            // perfectly ordinary hits as "mixed".
            //
            // The row already passed the full FTS NOT expression, so no
            // negative term exists in either indexed column. Here we only
            // need to ask whether all positive groups can be satisfied by
            // body alone or speaker alone; if terms are distributed across
            // both columns, "mixed" is the honest answer.
            let body_stream = fts_token_stream(&raw_text);
            let speaker_stream = fts_token_stream(&character_norm);
            let body_hit = terms.positives_match(&[body_stream.as_str()]);
            let speaker_hit = terms.positives_match(&[speaker_stream.as_str()]);
            let match_target = if body_hit {
                "body"
            } else if speaker_hit {
                "speaker"
            } else {
                "mixed"
            };

            // Build the preview. When the body actually contains the term we
            // center the preview around the match; for multi-term queries the
            // full probe almost never hits, so fall back to per-term probes
            // (whole terms first, then single atoms) before giving up and
            // clipping the head — a hit at the tail of a long narration used
            // to vanish from its own preview. Short "好 / 嗯 / mon3tr"
            // segments still end up shown whole either way.
            let matched_text = {
                let extracted = self.extract_context_any(
                    &raw_text,
                    std::iter::once(context_probe.as_str()).chain(terms.preview_probes()),
                );
                if extracted.trim().is_empty() {
                    Self::clip_preview(&raw_text, 240)
                } else {
                    extracted
                }
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

        // Skip the COUNT(*) round-trip when we clearly aren't truncated —
        // `rows.len() < LIMIT` implies every matching segment row is in
        // `hits`. Only when the LIMIT kicked in do we need the authoritative
        // total to drive the "已显示 X / Y" hint in the UI. 必须在合并标题
        // 伪命中**之前**判断：标题命中把 hits 填到上限并不代表段落查询被
        // 截断，反之段落行数没到上限时 COUNT 也不会更大。
        let seg_returned = hits.len();
        let (seg_total, seg_count_uncertain) = if seg_returned >= SEARCH_RESULT_LIMIT {
            let counted = conn
                .query_row(
                    "SELECT COUNT(*) FROM story_segment_index WHERE story_segment_index MATCH ?1",
                    params![fts_query.clone()],
                    |row| row.get(0),
                )
                .ok()
                .map(|total: i64| total.max(0) as usize);
            resolve_limited_match_total(seg_returned, counted)
        } else {
            (seg_returned, false)
        };

        // Merge story-name / story-code hits from the story-level index so
        // exact title lookups like `大地惊雷` still surface as a clickable
        // result even though the title itself isn't stored as a segment.
        // Each such hit is presented as a pseudo-"header" segment at index 0
        // so the reader lands on the beginning of the story when clicked.
        //
        // 被 LIMIT 掐掉的标题命中也要计入总数：段落命中恰好填满上限时，
        // 以前这里静默丢掉全部标题命中，`total_matched` 却只报段落 COUNT，
        // `truncated` 顺势谎报成 false——用户看到「共 N 段」以为一条不少，
        // 实际标题命中根本没进列表。
        let mut title_total = 0usize;
        if let Ok(story_rows) = Self::story_level_title_hits(&conn, &fts_query, trimmed, labels) {
            let fresh: Vec<SegmentHit> = story_rows
                .into_iter()
                .filter(|hit| !seen.contains(&(hit.story_id.clone(), hit.segment_index)))
                .collect();
            title_total = fresh.len();
            // `fresh` 与段落命中已去重，且每个 story_id 至多一行。
            let remaining = SEARCH_RESULT_LIMIT.saturating_sub(hits.len());
            hits.extend(fresh.into_iter().take(remaining));
        }

        let total_matched = seg_total + title_total;
        // 截断与否只有一个诚实的判据：还有没有没返回的命中。
        // COUNT 自身若在 LIMIT 边界失败，我们不知道还有没有下一行，必须
        // 承认结果可能被截断；把失败悄悄回退成 returned 会谎报 false。
        let truncated = seg_count_uncertain || total_matched > hits.len();

        progress("完成", 2, 2, format!("命中 {} 段", total_matched));

        Ok(SegmentSearchPage {
            hits,
            total_matched,
            truncated,
            index_used: true,
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
    /// on the complete story-level result set and post-filter it with the
    /// same token/boolean matcher as fallback search. A pre-filter LIMIT is
    /// unsafe: body-only rows can occupy those slots and hide later title
    /// hits, while `totalMatched` silently undercounts every hidden title.
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

        // Post-filter with the same semantics as FTS/fallback: OR groups,
        // explicit AND/NOT, phrases, and ASCII prefixes all remain meaningful.
        // A flattened `contains(query_raw)` probe included connective and
        // negative words as if they were positive prose, so title jumps
        // disappeared for nearly every advanced query.
        let terms = split_query_terms(query_raw);
        if terms.positive.is_empty() {
            return Ok(Vec::new());
        }

        let mut hits = Vec::new();
        for row in rows {
            let Ok((story_id, story_name, category, story_code)) = row else {
                continue;
            };
            let name_stream = fts_token_stream(&story_name);
            let code_stream = fts_token_stream(&story_code);
            let columns = [name_stream.as_str(), code_stream.as_str()];
            if !terms.positives_match(&columns) || terms.excluded_by(&columns) {
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

        let (results, _index_used) = self.search_stories_emitting(Some(app), trimmed)?;
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
    ) -> Result<(Vec<SearchResult>, bool), String> {
        const SCAN_PROGRESS_STRIDE: usize = 32;

        let Some(app) = app else {
            return self.search_stories_with_source(trimmed);
        };

        emit_search_progress(app, "检索", 0, 0, "尝试全文索引");
        match self.search_stories_with_index(trimmed) {
            Ok(Some(results)) => {
                let index_used = Self::build_fts_query_advanced(trimmed).is_some();
                let message = if index_used {
                    "使用全文索引完成"
                } else {
                    "查询没有可用的正向词"
                };
                emit_search_progress(app, "索引检索", 1, 1, message);
                return Ok((results, index_used));
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
        .map(|results| (results, false))
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
    pub fn get_story_neighbors(
        &self,
        story_id: &str,
    ) -> Result<crate::models::StoryNeighbors, String> {
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

        // story_table 是肉鸽目录的权威来源；meta 只提供更友好的 desc。旧实现
        // 在 meta 缺失/损坏时直接 `?` 返回，导致明明完整存在于 story_table
        // 的肉鸽剧情从列表、索引、get_story_entry 和邻接导航中一起消失。
        // 元数据失败只降级到文件名，绝不能放弃权威表。
        let meta_file = self.data_dir.join(REVIEW_META_TABLE_REL);
        let mut path_desc_map: HashMap<String, String> = HashMap::new();
        match fs::read_to_string(&meta_file) {
            Ok(meta_content) => match serde_json::from_str::<Value>(&meta_content) {
                Ok(meta_value) => collect_content_paths(&mut path_desc_map, &meta_value),
                Err(err) => {
                    eprintln!("[CATALOG] 肉鸽描述元数据损坏，降级使用稳定路径名: {}", err);
                }
            },
            Err(err) => {
                eprintln!(
                    "[CATALOG] 肉鸽描述元数据不可读，降级使用稳定路径名: {}",
                    err
                );
            }
        }

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
                .then_with(|| {
                    extract_numeric_parts(&a.story_txt).cmp(&extract_numeric_parts(&b.story_txt))
                })
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

/// 简介（`[uc]info`）不走解析器，正文里由 `clean_text` 落地的插值符在
/// 这里要做同一套归一：`{@nbs}` 是不换行空格（act45side 的
/// "Ave{@nbs}Mujica"，不替换就原样渲染到简介卡上），`{@nickname}` 是
/// 玩家代称「博士」，两者都不区分大小写——与解析器的 `NBS_RE` /
/// `NICKNAME_RE` 同语义。语料里的插值符全集只有这两种，其余花括号都是
/// 正文，原样保留，不做通配剥除。
fn normalize_info_interpolations(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(pos) = rest.find("{@") {
        out.push_str(&rest[..pos]);
        let candidate = &rest[pos..];
        let replacement = candidate.find('}').and_then(|end| {
            let name = &candidate[2..end];
            if name.eq_ignore_ascii_case("nbs") {
                Some((" ", end + 1))
            } else if name.eq_ignore_ascii_case("nickname") {
                Some(("博士", end + 1))
            } else {
                None
            }
        });
        match replacement {
            Some((text, consumed)) => {
                out.push_str(text);
                rest = &candidate[consumed..];
            }
            None => {
                // 不认识的插值符（或没闭合的花括号）是正文，原样保留。
                out.push_str("{@");
                rest = &candidate["{@".len()..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// 从密录 storyTxt 里抠出「属于哪位干员」的分组 key，判定与前端
/// `extractCharTokenFromStoryTxt` 保持一致。历史格式
/// `obt/memory/char_002_amiya/...` 直接取 `char_` 段；当前主流格式
/// `obt/memory/story_{alias}_N_M`（alias 是 charId 尾段，如 kroos、amgoat）
/// 取 `story_` 与下一个 `_` 之间的 alias。只认前一种的话，新格式全部落进
/// 「按剧情标题排序」的兜底，同一位干员的几篇密录在列表里四散开。
fn extract_char_token(story_txt: &str) -> Option<String> {
    let segments: Vec<&str> = story_txt.split(|c| c == '/' || c == '\\').collect();
    // 前端正则带 `/i`，`story_` 分支和 `memory` 段在这里也都不区分大小写；
    // `char_` 前缀不能独独区分——路径大小写从来不是数据侧的承诺，认不出
    // 前缀的密录会静默跌进「按标题排序」的兜底。
    if let Some(seg) = segments.iter().find(|seg| {
        seg.get(.."char_".len())
            .is_some_and(|head| head.eq_ignore_ascii_case("char_"))
    }) {
        return Some(seg.to_ascii_lowercase());
    }
    segments.windows(2).find_map(|pair| {
        if !pair[0].eq_ignore_ascii_case("memory") {
            return None;
        }
        let rest = pair[1]
            .get(.."story_".len())
            .filter(|head| head.eq_ignore_ascii_case("story_"))
            .map(|_| &pair[1]["story_".len()..])?;
        let alias_len = rest
            .find(|c: char| !c.is_ascii_alphanumeric())
            .unwrap_or(rest.len());
        // 与前端正则一致：alias 后必须还跟着 `_篇号` 才算密录文件名。
        if alias_len == 0 || !rest[alias_len..].starts_with('_') {
            return None;
        }
        Some(rest[..alias_len].to_ascii_lowercase())
    })
}

/// 扫描原始脚本里第一条 `[Background(...)]` 的 image token。属性提取必须与
/// 解析器 `ATTR_RE` 同一套语义：`=` 两侧允许空白，值可以是双引号、单引号
/// （act15mini 全篇用单引号写属性）或裸词，键必须是完整的 `image`
/// （`fadeimage=` 不算）。不认单引号的话，token 会连引号一起被带回去，
/// 前端拿它拼 URL 必然落空——比「没有缩略图」更糟。
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
        // 指令名要整词匹配，和属性侧的 `fadeimage`≠`image` 是同一条规矩：
        // 解析器在 `(`/空格/`=` 处截断指令名后**精确**比对，
        // `[BackgroundTween(...)]` 是另一条指令，它的属性不能冒认成背景图。
        match lowered.as_bytes().get("[background".len()) {
            None | Some(b'(') | Some(b' ') | Some(b'=') | Some(b']') => {}
            _ => continue,
        }
        if let Some(token) = extract_image_attr_value(trimmed, &lowered) {
            return Some(token.to_string());
        }
    }
    None
}

/// 在一行指令原文里提取 `image` 属性值。`lowered` 是 `line` 的 ASCII 小写
/// 副本（字节长度相同）：用它定位、用原串切值，token 的大小写才能保留
/// （`bg_Rhodes`）。行尾 `\` 把指令拆成两半时（引号没闭合、或值只剩一个
/// `\`），宁可返回 None 也不产出垃圾 token。
fn extract_image_attr_value<'a>(line: &'a str, lowered: &str) -> Option<&'a str> {
    let bytes = lowered.as_bytes();
    let mut from = 0usize;
    while let Some(rel) = lowered[from..].find("image") {
        let key_start = from + rel;
        let mut idx = key_start + "image".len();
        from = idx;
        // 键要独立成词：`fadeimage=` 里的 image 是别的属性名的一部分。
        if key_start > 0 {
            let prev = bytes[key_start - 1];
            if prev.is_ascii_alphanumeric() || prev == b'_' {
                continue;
            }
        }
        while bytes.get(idx).is_some_and(|b| *b == b' ' || *b == b'\t') {
            idx += 1;
        }
        if bytes.get(idx) != Some(&b'=') {
            // `imagegroup=` 之类更长的键，或没有赋值。
            continue;
        }
        idx += 1;
        while bytes.get(idx).is_some_and(|b| *b == b' ' || *b == b'\t') {
            idx += 1;
        }
        // 到这里 idx 只跨过了 ASCII 字节，切原串是安全的。
        let rest = &line[idx..];
        let value = match rest.as_bytes().first().copied() {
            Some(quote @ (b'"' | b'\'')) => {
                let inner = &rest[1..];
                // 引号没闭合＝指令被行尾 `\` 续行拆开了，这一行不算数。
                let end = inner.find(quote as char)?;
                &inner[..end]
            }
            Some(_) => {
                let end = rest
                    .find(|c: char| {
                        c.is_whitespace()
                            || matches!(c, ',' | '(' | ')' | '[' | ']' | '"' | '\'' | '\\')
                    })
                    .unwrap_or(rest.len());
                &rest[..end]
            }
            None => continue,
        };
        let token = value.trim().trim_start_matches('$').trim();
        if !token.is_empty() {
            return Some(token);
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

        // 简介不经解析器，插值符要在返回前按 `clean_text` 的语义落地：
        // `{@nbs}`（不区分大小写）→ 空格，`{@nickname}` → 博士；其余
        // 花括号是正文，原样保留。
        fs::write(
            info_dir.join("interp.txt"),
            "Ave{@nbs}Mujica即将开演。\n{@NickName}，{@NBS}请入席。{保留}",
        )
        .unwrap();
        let content = service
            .read_story_info("info/demo/interp")
            .expect("should read interpolated summary");
        assert_eq!(content, "Ave Mujica即将开演。\n博士， 请入席。{保留}");

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn normalize_info_interpolations_matches_parser_semantics() {
        assert_eq!(
            normalize_info_interpolations("Ave{@nbs}Mujica"),
            "Ave Mujica"
        );
        assert_eq!(
            normalize_info_interpolations("Ave{@NBS}Mujica"),
            "Ave Mujica"
        );
        assert_eq!(
            normalize_info_interpolations("{@nickname}，你来了"),
            "博士，你来了"
        );
        assert_eq!(
            normalize_info_interpolations("{@NickName}早上好"),
            "博士早上好"
        );
        // 只认这两种插值符：别的花括号（含没闭合的）都是正文。
        assert_eq!(
            normalize_info_interpolations("{@unknown}与{tag}与{@nbs"),
            "{@unknown}与{tag}与{@nbs"
        );
        // 与正则语义一致：外层残缺花括号不影响内层完整插值符。
        assert_eq!(normalize_info_interpolations("{@{@nbs}"), "{@ ");
        assert_eq!(normalize_info_interpolations(""), "");
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

        assert!(service
            .get_story_preview_token("demo/plain")
            .unwrap()
            .is_none());

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
        // 前端正则带 `/i`：历史 `char_` 格式同样不看路径大小写。
        assert_eq!(
            extract_char_token("Obt/Memory/CHAR_002_AMIYA/CHAR_002_AMIYA_1"),
            Some("char_002_amiya".to_string())
        );
        assert_eq!(extract_char_token("obt/main/level_main_01-01_beg"), None);
        // 当前主流格式：文件直接躺在 memory 目录下，alias 是 charId 尾段。
        assert_eq!(
            extract_char_token("obt/memory/story_kroos_1_1"),
            Some("kroos".to_string())
        );
        assert_eq!(
            extract_char_token("Obt/Memory/Story_Amgoat_2_1"),
            Some("amgoat".to_string())
        );
        // alias 后没有 `_篇号` 尾巴、或不在 memory 目录下的都不算。
        assert_eq!(extract_char_token("obt/memory/story_kroos"), None);
        assert_eq!(extract_char_token("activities/act1/story_act1_01"), None);
    }

    /// 干员密录（storySort 全 0）必须按「干员 → 篇号数值」排，而不是退回
    /// 按剧情标题排。`story_{alias}_N_M` 是当前数据的主流路径格式，认不出
    /// alias 的话，同一位干员的密录会按各自标题散排在整张列表里。
    #[test]
    fn memory_stories_stay_grouped_by_operator_in_story_alias_format() {
        let json = r#"{
          "mem_kroos": {
            "entryType": "NONE",
            "infoUnlockDatas": [
              {"storyId":"st_kroos_2","storyName":"黄昏","storyGroup":"mem_kroos","storySort":0,"storyTxt":"obt/memory/story_kroos_2_1","storyReviewType":"NORMAL","unLockType":"AUTO"},
              {"storyId":"st_kroos_10","storyName":"重逢","storyGroup":"mem_kroos","storySort":0,"storyTxt":"obt/memory/story_kroos_10_1","storyReviewType":"NORMAL","unLockType":"AUTO"},
              {"storyId":"st_kroos_1","storyName":"相遇","storyGroup":"mem_kroos","storySort":0,"storyTxt":"obt/memory/story_kroos_1_1","storyReviewType":"NORMAL","unLockType":"AUTO"}
            ]
          },
          "mem_amgoat": {
            "entryType": "NONE",
            "infoUnlockDatas": [
              {"storyId":"st_amgoat_2","storyName":"试炼","storyGroup":"mem_amgoat","storySort":0,"storyTxt":"obt/memory/story_amgoat_2_1","storyReviewType":"NORMAL","unLockType":"AUTO"},
              {"storyId":"st_amgoat_1","storyName":"火焰","storyGroup":"mem_amgoat","storySort":0,"storyTxt":"obt/memory/story_amgoat_1_1","storyReviewType":"NORMAL","unLockType":"AUTO"}
            ]
          }
        }"#;
        let data: HashMap<String, Value> = serde_json::from_str(json).unwrap();
        let stories = DataService::build_memory_stories(&data);
        let ids: Vec<&str> = stories.iter().map(|s| s.story_id.as_str()).collect();
        // 按标题排的话会得到 火焰、相遇、试炼、重逢、黄昏 的干员交错序；
        // 篇号还必须按数值比（2 在 10 前面）。
        assert_eq!(
            ids,
            vec![
                "st_amgoat_1",
                "st_amgoat_2",
                "st_kroos_1",
                "st_kroos_2",
                "st_kroos_10"
            ],
            "同一位干员的密录必须连在一起，且按篇号数值序"
        );
    }

    #[test]
    fn background_token_follows_parser_attribute_syntax() {
        // 单引号（act15mini 的属性写法）：引号绝不能混进 token。
        assert_eq!(
            first_background_token("[Background(image='bg_act15', fadetime=1)]").as_deref(),
            Some("bg_act15")
        );
        // `=` 两侧的空白解析器认，这里也要认；token 保留原始大小写。
        assert_eq!(
            first_background_token("[background(image = \"bg_Camp\")]").as_deref(),
            Some("bg_Camp")
        );
        // 裸词值 + `$` 前缀。
        assert_eq!(
            first_background_token("[Background(image=$bg_dollar)]").as_deref(),
            Some("bg_dollar")
        );
        // `fadeimage=` 不是 `image` 键，不能把它的值当背景。
        assert_eq!(
            first_background_token(
                "[Background(fadeimage=\"bg_wrong\")]\n[Background(image=\"bg_right\")]"
            )
            .as_deref(),
            Some("bg_right")
        );
        // 指令名同样要整词匹配：`[BackgroundTween]` 是另一条指令，
        // 解析器按截断后的指令名精确比对，这里不能靠前缀冒领。
        assert_eq!(
            first_background_token(
                "[BackgroundTween(image=\"bg_tween\", duration=1)]\n[Background(image=\"bg_scene\")]"
            )
            .as_deref(),
            Some("bg_scene")
        );
        // 但整词判定不能收得过紧：指令名后跟空格、或裸 `[Background]`
        // 在解析器里都还是 background。
        assert_eq!(
            first_background_token("[background (image='bg_spaced')]").as_deref(),
            Some("bg_spaced")
        );
        assert_eq!(
            first_background_token("[Background]\n[Background(image=\"bg_bare\")]").as_deref(),
            Some("bg_bare")
        );
        // 行尾 `\` 把指令拆成两半时，宁可没有缩略图也不能返回垃圾 token。
        assert_eq!(
            first_background_token("[Background(image=\\\n\"bg_split\")]"),
            None
        );
        assert_eq!(
            first_background_token("[Background(image=\"bg_split\\\n\", fadetime=1)]"),
            None
        );
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
        assert_eq!(normalize_for_fuzzy("{@nickname}，你好"), "博士你好");
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

    /// 判定发生在与索引相同的 token 流上；测试给原文，这里代为转换。
    fn matches_text(terms: &QueryTerms, text: &str) -> bool {
        let hay = fts_token_stream(text);
        terms.positives_match(&[hay.as_str()])
    }

    fn excludes_text(terms: &QueryTerms, text: &str) -> bool {
        let hay = fts_token_stream(text);
        terms.excluded_by(&[hay.as_str()])
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
        // 短语保留原子序列并要求连续出现，对应 FTS 的 `"凯 尔 希 阿 米 娅"`。
        assert_eq!(terms.positive[0][0].kind, TermKind::Phrase);
        assert_eq!(
            terms.positive[0][0].atoms,
            vec!["凯", "尔", "希", "阿", "米", "娅"]
        );
        assert!(matches_text(&terms, "和凯尔希阿米娅一起"));
        assert!(!matches_text(&terms, "凯尔希在，阿米娅不在"));
    }

    #[test]
    fn split_query_terms_bare_cjk_is_char_level_like_the_index() {
        // 普通词对应 FTS 的 `("凯" AND "尔" AND "希")`：逐字命中即可，不要求
        // 连续。线性扫描必须用同样的判定，否则索引建好前后结果集会变。
        let terms = split_query_terms("凯尔希");
        assert_eq!(terms.positive[0][0].atoms, vec!["凯", "尔", "希"]);
        assert!(matches_text(&terms, "凯尔希"));
        assert!(matches_text(&terms, "凯瑟琳、尔后、希望"));
        assert!(!matches_text(&terms, "凯尔"));
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
        assert!(matches_text(&terms, "博士说过的话"));
        assert!(excludes_text(&terms, "凯尔希说过的话"));
        assert!(!excludes_text(&terms, "博士说过的话"));
    }

    #[test]
    fn split_query_terms_negated_phrase_stays_negative() {
        // `-"..."` 的减号在引号外，归一化会把它抹掉；不特判的话否定短语会
        // 变成肯定短语，语义正好反过来。
        let terms = split_query_terms("博士 -\"凯尔希\"");
        assert_eq!(positive_texts(&terms), vec![vec!["博士"]]);
        assert_eq!(negative_texts(&terms), vec!["凯尔希"]);
        assert!(excludes_text(&terms, "凯尔希来了"));

        // 引号没闭合时同样保住否定语义。
        let terms = split_query_terms("博士 -\"凯尔希");
        assert_eq!(negative_texts(&terms), vec!["凯尔希"]);
    }

    #[test]
    fn split_query_terms_or_is_consumed_by_negative_term() {
        // `or` 归它后面紧跟的词；那个词是否定项时 `or` 随之作废，不能漂给
        // 再下一个正向词。FTS 侧对同一查询生成 `(希 AND 雪) NOT 章`，
        // 扫描回退必须给出同样的 AND 分组。
        let terms = split_query_terms("希 or -章 雪");
        assert_eq!(positive_texts(&terms), vec![vec!["希"], vec!["雪"]]);
        assert_eq!(negative_texts(&terms), vec!["章"]);
    }

    #[test]
    fn split_query_terms_or_dies_with_untokenizable_term() {
        // 假名切不出原子，词被整个丢弃时要把它前面的 `or` 一起带走——
        // FTS 侧此时生成 `希 AND 雪`，不是 `希 OR 雪`。
        let terms = split_query_terms("希 or アイ 雪");
        assert_eq!(positive_texts(&terms), vec![vec!["希"], vec!["雪"]]);
        assert!(terms.negative.is_empty());
    }

    #[test]
    fn split_query_terms_quoted_or_is_a_literal() {
        // 引号里的 `or` 是要搜的词，不是连接词。
        let terms = split_query_terms("\"or\" 博士");
        assert_eq!(positive_texts(&terms), vec![vec!["or"], vec!["博士"]]);
    }

    #[test]
    fn split_query_terms_fullwidth_minus_is_negation() {
        // 全角减号（中文输入法全角标点档）要 NFKC 之后才是 `-`。FTS 侧对
        // 整个查询先归一化再解析，把 `－凯尔希` 当排除；回退侧必须一致，
        // 否则索引建好前后同一查询的语义正好相反。
        let terms = split_query_terms("－凯尔希 博士");
        assert_eq!(positive_texts(&terms), vec![vec!["博士"]]);
        assert_eq!(negative_texts(&terms), vec!["凯尔希"]);
    }

    #[test]
    fn split_query_terms_fullwidth_quotes_make_a_phrase() {
        // 全角引号 U+FF02 NFKC 后是 `"`，FTS 侧按短语解析；回退侧一致。
        let terms = split_query_terms("＂凯尔希 阿米娅＂");
        assert_eq!(positive_texts(&terms), vec![vec!["凯尔希阿米娅"]]);
        assert_eq!(terms.positive[0][0].kind, TermKind::Phrase);
        assert!(matches_text(&terms, "凯尔希阿米娅登场"));
        assert!(!matches_text(&terms, "凯尔希与阿米娅"));
    }

    #[test]
    fn split_query_terms_decorated_or_is_a_term_not_a_connective() {
        // FTS 侧只有整个 token 恰好是 `or` 才算连接词。回退侧此前在去掉
        // 标点之后的文本上判定，`or，` 会被误当连接词，同一查询在两条
        // 路径下一个是 OR、一个是 AND。
        let terms = split_query_terms("凯尔希 or， 阿米娅");
        assert_eq!(
            positive_texts(&terms),
            vec![vec!["凯尔希"], vec!["or"], vec!["阿米娅"]]
        );

        // `-or` 是「排除 or」，不是连接词；负项标记不能丢。
        let terms = split_query_terms("博士 -or");
        assert_eq!(positive_texts(&terms), vec![vec!["博士"]]);
        assert_eq!(negative_texts(&terms), vec!["or"]);
    }

    #[test]
    fn split_query_terms_or_dies_with_punct_only_term() {
        // 纯标点词在 FTS 侧要到子句生成阶段才被丢掉，它前面的 `or` 已被
        // 消费掉了；回退侧此前在归一化时就丢词，`or` 漂给下一个词变成 OR。
        let terms = split_query_terms("希 or ， 雪");
        assert_eq!(positive_texts(&terms), vec![vec!["希"], vec!["雪"]]);

        // 纯减号串两边都不产生词条，`or` 照旧顺延——与 FTS 侧一致。
        let terms = split_query_terms("希 or - 雪");
        assert_eq!(positive_texts(&terms), vec![vec!["希", "雪"]]);
    }

    #[test]
    fn split_query_terms_or_group_matches_either_alternative() {
        let terms = split_query_terms("凯尔希 or 阿米娅");
        assert!(matches_text(&terms, "只提到凯尔希"));
        assert!(matches_text(&terms, "只提到阿米娅"));
        assert!(!matches_text(&terms, "只提到博士"));
    }

    #[test]
    fn split_query_terms_atoms_break_at_punctuation_like_the_index() {
        // FTS 侧 `term_to_clause` 在标点处断词：`0-1` → `(0* AND 1*)` 两个
        // 独立 token。原子若切在去标点之后的文本上，会粘成要求连续出现的
        // `01`——「0」「1」分居标题与正文的剧情就只有索引路径能搜到。
        assert_eq!(
            DataService::build_fts_query_advanced("0-1").as_deref(),
            Some("(0* AND 1*)")
        );
        let terms = split_query_terms("0-1");
        assert_eq!(terms.positive[0][0].atoms, vec!["0", "1"]);
        assert!(matches_text(&terms, "编队0号与1号"));

        let terms = split_query_terms("prts-2");
        assert_eq!(terms.positive[0][0].atoms, vec!["prts", "2"]);
    }

    #[test]
    fn word_ascii_atoms_match_token_prefixes_like_fts() {
        // FTS 的 `prts*` 只认「以 prts 开头的 token」。以前回退侧在压平文本
        // 上做子串 contains：`superprts` 的腹部、`grape rts` 压平后的骑缝
        // （`graperts`）都会被误命中，索引建好前后结果集分叉。
        let terms = split_query_terms("prts");
        assert!(matches_text(&terms, "PRTS系统上线"));
        assert!(matches_text(&terms, "prts2 已部署")); // 前缀命中，同 `prts*`
        assert!(!matches_text(&terms, "superprts 出场"));
        assert!(!matches_text(&terms, "grape rts"));

        // 数字同理：`0*` 不命中 `10` 的个位。查询 `0-1` 以前会命中任何
        // 同时含 0 和 1 的数字串（如「第10回合，2020年」）。
        let terms = split_query_terms("0-1");
        assert!(matches_text(&terms, "0号与1号"));
        assert!(!matches_text(&terms, "第10回合，2020年"));
    }

    #[test]
    fn phrase_atoms_match_consecutive_exact_tokens_like_fts() {
        // ASCII 短语在 FTS 里是精确 token 序列（没有前缀星号）。以前回退侧
        // 把原子拼接后做子串 contains，`foobar`、骑缝的 `foob ar` 都会被
        // 误命中；`"prts"` 也会命中 `prts2`。
        let terms = split_query_terms("\"foo bar\"");
        assert!(matches_text(&terms, "说 foo bar 的人"));
        assert!(!matches_text(&terms, "foobar"));
        assert!(!matches_text(&terms, "xfoo bar"));
        assert!(!matches_text(&terms, "foob ar"));

        let terms = split_query_terms("\"prts\"");
        assert!(matches_text(&terms, "prts 系统"));
        assert!(!matches_text(&terms, "prts2 系统"));

        // 分词器丢掉的字符（假名等）不打断 token 相邻：`凯あ尔` 在索引里
        // 就是相邻的 `凯 尔`，FTS 短语能命中，回退侧必须一样。
        let terms = split_query_terms("\"凯尔\"");
        assert!(matches_text(&terms, "凯あ尔"));
        assert!(matches_text(&terms, "凯、尔"));
        assert!(!matches_text(&terms, "凯不挨着尔"));
    }

    #[test]
    fn bare_and_mixes_with_or_like_the_index() {
        // `AND` 与 `or` 混写：裸词 and 是无操作连接词，or 只并相邻两项。
        // FTS 串与回退分组都必须与去掉 and 的写法逐字节 / 逐项相同。
        assert_eq!(
            DataService::build_fts_query_advanced("希 or 章 AND 雪"),
            DataService::build_fts_query_advanced("希 or 章 雪")
        );
        assert_eq!(
            DataService::build_fts_query_advanced("希 or 章 AND 雪").as_deref(),
            Some("(\"希\" OR \"章\") AND \"雪\"")
        );
        assert_eq!(
            split_query_terms("希 or 章 AND 雪"),
            split_query_terms("希 or 章 雪")
        );

        // `A AND B or C`：AND 不打断后面的 OR 组，语义是 A AND (B OR C)。
        assert_eq!(
            DataService::build_fts_query_advanced("凯尔希 AND 博士 or 德克萨斯"),
            DataService::build_fts_query_advanced("凯尔希 博士 or 德克萨斯")
        );
        let terms = split_query_terms("凯尔希 AND 博士 or 德克萨斯");
        assert_eq!(
            positive_texts(&terms),
            vec![vec!["凯尔希"], vec!["博士", "德克萨斯"]]
        );

        // `A or AND B`：夹在中间的 and 不吞掉悬挂的 or。
        assert_eq!(
            split_query_terms("凯尔希 or AND 阿米娅"),
            split_query_terms("凯尔希 or 阿米娅")
        );
        assert_eq!(
            DataService::build_fts_query_advanced("凯尔希 or AND 阿米娅"),
            DataService::build_fts_query_advanced("凯尔希 or 阿米娅")
        );
    }

    #[test]
    fn fullwidth_connectives_fold_to_keywords_after_nfkc() {
        // 全角字母（中文输入法全角档）经 NFKC + 小写后就是 and/or/not，
        // 两条路径都解析在归一化后的文本上，必须与半角写法完全等价。
        let pairs = [
            ("凯尔希 ＡＮＤ 博士", "凯尔希 博士"),
            ("凯尔希 ＯＲ 博士", "凯尔希 or 博士"),
            ("凯尔希 ＮＯＴ 博士", "凯尔希 -博士"),
        ];
        for (fullwidth, canonical) in pairs {
            assert_eq!(
                DataService::build_fts_query_advanced(fullwidth),
                DataService::build_fts_query_advanced(canonical),
                "FTS 串分叉: {:?} vs {:?}",
                fullwidth,
                canonical
            );
            assert_eq!(
                split_query_terms(fullwidth),
                split_query_terms(canonical),
                "回退解析分叉: {:?} vs {:?}",
                fullwidth,
                canonical
            );
        }
        // 语义抽查：全角 ＮＯＴ 真的把「博士」放进了排除列表。
        let terms = split_query_terms("凯尔希 ＮＯＴ 博士");
        assert_eq!(positive_texts(&terms), vec![vec!["凯尔希"]]);
        assert_eq!(negative_texts(&terms), vec!["博士"]);
    }

    #[test]
    fn bare_and_is_the_same_query_as_implicit_and() {
        // `凯尔希 AND 博士` 与 `凯尔希 博士`：FTS 串逐字节相同，回退侧
        // 分组也逐项相同——裸词 and 只是无操作连接词。
        assert_eq!(
            DataService::build_fts_query_advanced("凯尔希 AND 博士"),
            DataService::build_fts_query_advanced("凯尔希 博士")
        );
        assert_eq!(
            split_query_terms("凯尔希 AND 博士"),
            split_query_terms("凯尔希 博士")
        );
        assert_eq!(
            positive_texts(&split_query_terms("凯尔希 AND 博士")),
            vec![vec!["凯尔希"], vec!["博士"]]
        );
    }

    #[test]
    fn bare_not_is_the_same_query_as_minus_prefix() {
        assert_eq!(
            DataService::build_fts_query_advanced("凯尔希 NOT 博士"),
            DataService::build_fts_query_advanced("凯尔希 -博士")
        );
        let terms = split_query_terms("凯尔希 NOT 博士");
        assert_eq!(terms, split_query_terms("凯尔希 -博士"));
        assert_eq!(positive_texts(&terms), vec![vec!["凯尔希"]]);
        assert_eq!(negative_texts(&terms), vec!["博士"]);
    }

    #[test]
    fn hanging_not_is_absorbed_by_an_already_negated_term() {
        // `not -凯尔希 阿米娅`：悬挂的 `not` 被自带减号的 `-凯尔希` 无条件
        // 消费，不能漂到「阿米娅」头上把正向词反转成排除词（85dff60）。
        let terms = split_query_terms("not -凯尔希 阿米娅");
        assert_eq!(positive_texts(&terms), vec![vec!["阿米娅"]]);
        assert_eq!(negative_texts(&terms), vec!["凯尔希"]);
        assert_eq!(
            DataService::build_fts_query_advanced("not -凯尔希 阿米娅"),
            DataService::build_fts_query_advanced("阿米娅 -凯尔希")
        );
    }

    #[test]
    fn hanging_not_is_absorbed_by_an_already_negated_phrase() {
        // 开引号版：`not -"凯尔希" 博士` 里 dash_prefix 与悬挂 `not` 同时
        // 出现，`not` 同样要被消费掉，「博士」保持正向。
        let terms = split_query_terms("not -\"凯尔希\" 博士");
        assert_eq!(positive_texts(&terms), vec![vec!["博士"]]);
        assert_eq!(negative_texts(&terms), vec!["凯尔希"]);
        assert_eq!(
            DataService::build_fts_query_advanced("not -\"凯尔希\" 博士"),
            DataService::build_fts_query_advanced("博士 -\"凯尔希\"")
        );
    }

    #[test]
    fn quoted_and_dashed_connective_words_are_literals() {
        // 引号里的 and/not 是要搜的词，不是连接词。
        assert_eq!(
            DataService::build_fts_query_advanced("\"and\"").as_deref(),
            Some("\"and\"")
        );
        assert_eq!(
            DataService::build_fts_query_advanced("\"not\"").as_deref(),
            Some("\"not\"")
        );
        assert_eq!(
            positive_texts(&split_query_terms("\"and\"")),
            vec![vec!["and"]]
        );
        assert_eq!(
            positive_texts(&split_query_terms("\"not\"")),
            vec![vec!["not"]]
        );

        // `-and` / `-not` 是「排除对应字面量」：连接词判定发生在去减号之前。
        let terms = split_query_terms("博士 -and");
        assert_eq!(positive_texts(&terms), vec![vec!["博士"]]);
        assert_eq!(negative_texts(&terms), vec!["and"]);
        let q = DataService::build_fts_query_advanced("博士 -and").unwrap();
        assert!(q.contains(" NOT and*"), "{}", q);

        let terms = split_query_terms("博士 -not");
        assert_eq!(negative_texts(&terms), vec!["not"]);
        let q = DataService::build_fts_query_advanced("博士 -not").unwrap();
        assert!(q.contains(" NOT not*"), "{}", q);
    }

    #[test]
    fn pure_not_query_is_empty_on_both_paths() {
        // 只有否定项的查询没有意义：FTS 侧给 None（调用方短路成空结果），
        // 回退侧没有任何正向组（扫描器同样直接返回空）。
        for query in ["NOT 博士", "-博士"] {
            assert!(
                DataService::build_fts_query_advanced(query).is_none(),
                "{:?} 只有否定项，FTS 必须给 None",
                query
            );
            let terms = split_query_terms(query);
            assert!(terms.positive.is_empty(), "{:?}", query);
            assert_eq!(negative_texts(&terms), vec!["博士"], "{:?}", query);
        }
    }

    #[test]
    fn or_before_hanging_not_is_consumed_with_the_negated_term() {
        // `or` 归它后面的词；那个词经悬挂 `not` 反转成否定项时 `or` 随之
        // 作废，不能漂给再下一个正向词把 AND 变成 OR。
        let terms = split_query_terms("凯尔希 or not 博士 阿米娅");
        assert_eq!(positive_texts(&terms), vec![vec!["凯尔希"], vec!["阿米娅"]]);
        assert_eq!(negative_texts(&terms), vec!["博士"]);
        assert_eq!(
            DataService::build_fts_query_advanced("凯尔希 or not 博士 阿米娅"),
            DataService::build_fts_query_advanced("凯尔希 阿米娅 -博士")
        );

        // 开头的 `or not X`：没有左操作数的 `or` 是噪音，剩下纯否定。
        assert!(DataService::build_fts_query_advanced("or not 博士").is_none());
        let terms = split_query_terms("or not 博士");
        assert!(terms.positive.is_empty());
        assert_eq!(negative_texts(&terms), vec!["博士"]);
    }

    #[test]
    fn connective_variants_keep_polarity_aligned_across_paths() {
        // 每一对等价写法在 FTS 串与回退解析上都必须逐字节 / 逐项相同——
        // 任何一边分叉，索引建好前后同一查询的结果集就不一样。
        let pairs = [
            ("凯尔希 AND 博士", "凯尔希 博士"),
            ("凯尔希 NOT 博士", "凯尔希 -博士"),
            ("not -凯尔希 阿米娅", "阿米娅 -凯尔希"),
            ("not -\"凯尔希\" 博士", "博士 -\"凯尔希\""),
            ("凯尔希 or not 博士 阿米娅", "凯尔希 阿米娅 -博士"),
        ];
        for (variant, canonical) in pairs {
            assert_eq!(
                DataService::build_fts_query_advanced(variant),
                DataService::build_fts_query_advanced(canonical),
                "FTS 串分叉: {:?} vs {:?}",
                variant,
                canonical
            );
            assert_eq!(
                split_query_terms(variant),
                split_query_terms(canonical),
                "回退解析分叉: {:?} vs {:?}",
                variant,
                canonical
            );
        }
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
        assert_eq!(
            q,
            "(\"凯\" AND \"尔\" AND \"希\" AND \"阿\" AND \"米\" AND \"娅\")"
        );
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
    fn fts_query_fullwidth_minus_is_negation() {
        // NFKC 把全角减号折成 `-`，所以 FTS 侧把 `－凯尔希` 当排除；
        // 与 split_query_terms_fullwidth_minus_is_negation 对齐。
        let q = DataService::build_fts_query_advanced("－凯尔希 博士").expect("non-empty");
        let not_idx = q.find(" NOT ").expect("fullwidth minus must negate");
        assert!(q[..not_idx].contains('博'), "positives first: {}", q);
        assert!(q[not_idx..].contains('凯'), "凯尔希 must be negated: {}", q);
    }

    #[test]
    fn fts_query_or_survival_matches_fallback_for_dropped_terms() {
        // 与 split_query_terms_or_dies_with_punct_only_term 逐条对齐：
        // 纯标点词在子句生成时被丢，但它已消费掉前面的 `or` → AND；
        // 纯减号串在解析时就没产生词条，`or` 顺延给下一个词 → OR。
        let q = DataService::build_fts_query_advanced("希 or ， 雪").expect("non-empty");
        assert_eq!(q, "\"希\" AND \"雪\"");
        let q = DataService::build_fts_query_advanced("希 or - 雪").expect("non-empty");
        assert_eq!(q, "(\"希\" OR \"雪\")");
    }

    #[test]
    fn fts_query_decorated_or_is_a_term_not_a_connective() {
        // 只有整个 token 恰好是 `or` 才是连接词；`or，` 是要搜的词。
        // 与 split_query_terms_decorated_or_is_a_term_not_a_connective 对齐。
        let q = DataService::build_fts_query_advanced("凯尔希 or， 阿米娅").expect("non-empty");
        assert!(!q.contains(" OR "), "no OR group expected: {}", q);
        assert!(q.contains("or*"), "`or，` must survive as a term: {}", q);
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
            self.write_story(
                "obt/main/level_main_00-02",
                "[name=\"阿米娅\"]我们出发吧。\n",
            );
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
        assert_eq!(
            neighbors.next.map(|s| s.story_id),
            Some("main_00-02".into())
        );

        let neighbors = fx.service.get_story_neighbors("main_00-02").unwrap();
        assert_eq!(
            neighbors.prev.map(|s| s.story_id),
            Some("main_00-01".into())
        );
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
    fn roguelike_story_table_survives_missing_description_metadata() {
        let fx = Fixture::new("rogue_no_meta");
        fs::remove_file(fx.excel().join("story_review_meta_table.json")).unwrap();

        let groups = fx.service.get_roguelike_stories_grouped().unwrap();
        let ids: Vec<&str> = groups[0]
            .1
            .iter()
            .map(|story| story.story_id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec!["Obt/Roguelike/ro2/ro2_1", "Obt/Roguelike/ro2/ro2_2"],
            "story-table keys remain stable IDs even without optional metadata"
        );
        assert_eq!(groups[0].1[0].story_name, "ro2_1");

        fx.service.rebuild_story_index().expect("index builds");
        let hits = fx.service.search_stories("缄默").unwrap();
        assert!(
            hits.iter()
                .any(|hit| hit.story_id == "Obt/Roguelike/ro2/ro2_2"),
            "missing descriptions must not remove roguelike stories from FTS"
        );
    }

    #[test]
    fn malformed_roguelike_metadata_only_loses_friendly_names() {
        let fx = Fixture::new("rogue_bad_meta");
        fs::write(
            fx.excel().join("story_review_meta_table.json"),
            "{\"roguelike\":",
        )
        .unwrap();

        let groups = fx.service.get_roguelike_stories_grouped().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].1.len(), 2);
        assert_eq!(groups[0].1[0].story_name, "ro2_1");
        assert_eq!(
            fx.service
                .get_story_entry("Obt/Roguelike/ro2/ro2_1")
                .unwrap()
                .story_id,
            "Obt/Roguelike/ro2/ro2_1"
        );
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
        assert!(fx
            .service
            .search_stories_ex("-凯尔希")
            .unwrap()
            .results
            .is_empty());

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
    fn segment_match_target_uses_full_query_semantics_per_column() {
        let fx = Fixture::new("segment_target");
        fx.service.rebuild_story_index().expect("index builds");

        // The OR expression is satisfied entirely by the speaker column.
        // A flattened "凯尔希or阿米娅" substring does not occur there and
        // used to mislabel every one of these rows as mixed.
        let speaker_page = fx.service.search_segments("凯尔希 OR 阿米娅").unwrap();
        let speaker_hits: Vec<&SegmentHit> = speaker_page
            .hits
            .iter()
            .filter(|hit| hit.segment_type == "dialogue")
            .collect();
        assert!(!speaker_hits.is_empty());
        assert!(
            speaker_hits.iter().all(|hit| hit.match_target == "speaker"),
            "OR speaker hits were mislabeled: {:?}",
            speaker_hits
                .iter()
                .map(|hit| (&hit.story_id, &hit.match_target))
                .collect::<Vec<_>>()
        );

        // Both AND terms live in the same body.
        let body_page = fx.service.search_segments("又见 AND 面").unwrap();
        let body = body_page
            .hits
            .iter()
            .find(|hit| hit.story_id == "Obt/Roguelike/ro2/ro2_1")
            .expect("roguelike body must match");
        assert_eq!(body.match_target, "body");

        // FTS allows terms to be distributed across indexed columns. Neither
        // column satisfies the whole query alone, so mixed is intentional.
        let mixed_page = fx.service.search_segments("凯尔希 AND 又见").unwrap();
        let mixed = mixed_page
            .hits
            .iter()
            .find(|hit| hit.story_id == "Obt/Roguelike/ro2/ro2_1")
            .expect("speaker+body query must match");
        assert_eq!(mixed.match_target, "mixed");
    }

    #[test]
    fn advanced_title_queries_produce_jump_targets() {
        let fx = Fixture::new("title_boolean");
        fx.service.rebuild_story_index().expect("index builds");

        for query in ["启程 OR 不存在", "启程 NOT 博士"] {
            let page = fx.service.search_segments(query).unwrap();
            let hit = page
                .hits
                .iter()
                .find(|hit| hit.story_id == "main_00-02")
                .unwrap_or_else(|| panic!("advanced title query produced no jump: {query}"));
            assert_eq!(hit.match_target, "title", "query: {query}");
            assert_eq!(hit.segment_index, 0, "title jumps land at story start");
        }
    }

    #[test]
    fn fallback_scan_matches_index_on_not_queries() {
        let fx = Fixture::new("fallback");
        // No index built: this exercises the linear scanner.
        let results = fx.service.search_stories("凯尔希 -博士").unwrap();
        let ids: Vec<&str> = results.iter().map(|r| r.story_id.as_str()).collect();
        assert_eq!(ids, vec!["Obt/Roguelike/ro2/ro2_1"]);
    }

    #[test]
    fn count_reports_unavailable_index_as_none_not_zero() {
        let fx = Fixture::new("count");

        // 索引没建：给不出权威总数，必须是 None 而不是谎报 0。此时页面
        // 的总数只能取「已返回条数」，且不能宣称截断。
        assert_eq!(fx.service.count_fts_matches("凯尔希").unwrap(), None);
        let page = fx.service.search_stories_ex("凯尔希").unwrap();
        assert_eq!(page.total_matched, page.results.len());
        assert!(!page.truncated);

        fx.service.rebuild_story_index().expect("index builds");
        // 建好后是权威数字：主线 00-01 + 肉鸽 ro2_1。
        assert_eq!(fx.service.count_fts_matches("凯尔希").unwrap(), Some(2));
        // 纯否定查询在索引路径同样明确空集：0 是权威的，不是「不可用」。
        assert_eq!(fx.service.count_fts_matches("-凯尔希").unwrap(), Some(0));
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
            // `or` 后面紧跟否定项：`or` 随之作废，语义是 (凯尔希 AND 雪)
            // NOT 博士。扫描侧若让 `or` 漂给「雪」，会多出一批错误命中。
            "凯尔希 or -博士 雪",
            // `or` 后面是切不出原子的词：同样随之作废，语义是 凯尔希 AND 雪。
            "凯尔希 or アイ 雪",
            // 裸词连接词与显式减号 / 隐式 AND 的等价写法。
            "凯尔希 AND 博士",
            "凯尔希 NOT 博士",
            // AND 与 or 混写：语义是 凯尔希 AND (博士 OR 德克萨斯)。
            "凯尔希 AND 博士 or 德克萨斯",
            // 全角连接词（NFKC 后才是 and/not）。
            "凯尔希 ＡＮＤ 博士",
            "凯尔希 ＮＯＴ 博士",
            // 悬挂 `not` 被已否定的 `-凯尔希` 消费，「雪」保持正向。
            "not -凯尔希 雪",
            // 开头的 `or` 是噪音，`not` 把「博士」反转成排除项。
            "or not 博士 凯尔希",
            // 引号里的连接词是字面量（语料里没有 → 两边都是空集）。
            "\"and\"",
            // storyCode 查询：原子在标点处断开，与 FTS 的 `(0* AND 1*)` 一致。
            "0-1",
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

    /// 目录里列了、脚本文件却读不出来的剧情（残缺的手工包）在两条搜索
    /// 路径上必须同样不可见：rebuild 会整篇跳过（不入 FTS 库），线性
    /// 扫描的标题快路径也必须跳过——否则索引建好前后同一查询的结果集
    /// 不一致，且命中的条目点开只会报读文件错误。
    #[test]
    fn fallback_title_hit_skips_stories_whose_script_is_unreadable() {
        let fx = Fixture::new("ghost_script");
        // 追加一篇脚本文件不存在的剧情；正常的 main_00-01 保留作对照。
        fx.set_review_table(&format!(
            "{{\"main_0\":{{\"id\":\"main_0\",\"name\":\"黑暗时代\",\"entryType\":\"MAINLINE\",\
              \"infoUnlockDatas\":[{},{}]}}}}",
            entry_json(
                "main_00-01",
                "序章",
                "main_0",
                1,
                "obt/main/level_main_00-01",
                "0-1",
            ),
            entry_json(
                "ghost_01",
                "幽灵篇章",
                "main_0",
                9,
                "obt/main/level_main_ghost",
                "9-9",
            )
        ));

        // 索引没建好：线性扫描。标题对得上，但脚本读不出来——不该命中。
        let scanned = fx.service.search_stories("幽灵篇章").unwrap();
        assert!(
            scanned.is_empty(),
            "缺脚本的剧情不该凭标题命中: {:?}",
            sorted_ids(&scanned)
        );
        // 对照组：脚本齐全的剧情照常凭标题命中。
        assert_eq!(
            sorted_ids(&fx.service.search_stories("序章").unwrap()),
            vec!["main_00-01".to_string()]
        );

        // 建好索引后同样为空——两条路径语料一致。
        fx.service.rebuild_story_index().expect("index builds");
        assert!(fx.service.search_stories("幽灵篇章").unwrap().is_empty());
        assert_eq!(
            sorted_ids(&fx.service.search_stories("序章").unwrap()),
            vec!["main_00-01".to_string()]
        );
    }

    /// storyCode 查询端到端：`0-1` 在索引建好前后都必须命中 0-1 这一篇，
    /// 且不许把「正文里凑巧有 0 和 1 的数字」的剧情捞进来——FTS 的 `0*`
    /// 只认以 0 开头的 token（`10`、`2020` 都不算），回退侧以前按子串
    /// contains 会把这类剧情误报出来，索引建好前后结果集分叉。
    #[test]
    fn story_code_query_hits_end_to_end_without_digit_noise() {
        let fx = Fixture::new("code_e2e");
        fx.set_review_table(&format!(
            "{{\"main_0\":{{\"id\":\"main_0\",\"name\":\"黑暗时代\",\"entryType\":\"MAINLINE\",\
              \"infoUnlockDatas\":[{},{}]}}}}",
            entry_json(
                "main_00-01",
                "序章",
                "main_0",
                1,
                "obt/main/level_main_00-01",
                "0-1",
            ),
            entry_json(
                "digit_noise",
                "回合战报",
                "main_0",
                2,
                "obt/main/level_main_digits",
                "9-9",
            )
        ));
        fx.write_story("obt/main/level_main_digits", "第10回合，兵力2020人。\n");

        // 索引没建好：线性扫描。凭 storyCode 命中，数字噪音不命中。
        assert_eq!(
            sorted_ids(&fx.service.search_stories("0-1").unwrap()),
            vec!["main_00-01".to_string()]
        );

        // 建好索引后同一批结果。
        fx.service.rebuild_story_index().expect("index builds");
        assert_eq!(
            sorted_ids(&fx.service.search_stories("0-1").unwrap()),
            vec!["main_00-01".to_string()]
        );
    }

    /// 索引侧的既有取舍：tokenized 全文为空的剧情（假名标题 + 无 token
    /// 正文）整篇不入库，storyCode 随之不可搜。扫描回退必须同样跳过——
    /// 以前标题快路径只要求「脚本读得出来」、正文分支也不做此判定，这类
    /// 剧情在索引建好前能凭 code 命中、建好后又消失，结果集分叉。
    #[test]
    fn fallback_skips_tokenless_stories_like_the_index() {
        let fx = Fixture::new("tokenless");
        fx.set_review_table(&format!(
            "{{\"main_0\":{{\"id\":\"main_0\",\"name\":\"黑暗时代\",\"entryType\":\"MAINLINE\",\
              \"infoUnlockDatas\":[{},{}]}}}}",
            entry_json(
                "main_00-01",
                "序章",
                "main_0",
                1,
                "obt/main/level_main_00-01",
                "0-1",
            ),
            entry_json(
                "kana_only",
                "アイ",
                "main_0",
                2,
                "obt/main/level_main_kana_only",
                "KN-1",
            )
        ));
        // 假名和标点都进不了索引：这篇的 tokenized 全文是空的。
        fx.write_story("obt/main/level_main_kana_only", "ふふ……\n");

        // 索引没建好：不能凭 storyCode 命中一篇索引里根本不存在的剧情。
        // 带排除词的写法走的是正文分支（非标题快路径），也必须一致。
        assert!(fx.service.search_stories("KN-1").unwrap().is_empty());
        assert!(fx.service.search_stories("KN-1 -博士").unwrap().is_empty());
        // 对照组：全文有 token 的剧情照常凭 code 命中。
        assert_eq!(
            sorted_ids(&fx.service.search_stories("0-1").unwrap()),
            vec!["main_00-01".to_string()]
        );

        // 建好索引后同一批结果——tokenized 为空的剧情两条路径都看不见。
        fx.service.rebuild_story_index().expect("index builds");
        assert!(fx.service.search_stories("KN-1").unwrap().is_empty());
        assert!(fx.service.search_stories("KN-1 -博士").unwrap().is_empty());
        assert_eq!(
            sorted_ids(&fx.service.search_stories("0-1").unwrap()),
            vec!["main_00-01".to_string()]
        );
    }

    /// 引号短语端到端：`"凯尔"` 要求凯、尔作为**相邻 token** 出现。分词器
    /// 丢掉的字符（假名）不打断相邻——`凯あ尔` 在索引里就是相邻的
    /// `凯 尔`，FTS 短语命中；真正隔着会成词的字（`凯不挨着尔`）才不命中。
    /// 回退侧以前在保留假名的压平文本上做 contains，前者只有索引能搜到。
    #[test]
    fn quoted_phrase_agrees_end_to_end_across_dropped_chars() {
        let fx = Fixture::new("phrase_e2e");
        fx.set_review_table(&format!(
            "{{\"main_0\":{{\"id\":\"main_0\",\"name\":\"黑暗时代\",\"entryType\":\"MAINLINE\",\
              \"infoUnlockDatas\":[{},{}]}}}}",
            entry_json(
                "kana_story",
                "插曲一",
                "main_0",
                1,
                "obt/main/level_main_kana",
                "",
            ),
            entry_json(
                "gap_story",
                "插曲二",
                "main_0",
                2,
                "obt/main/level_main_gap",
                "",
            )
        ));
        fx.write_story("obt/main/level_main_kana", "凯あ尔登场。\n");
        fx.write_story("obt/main/level_main_gap", "凯不挨着尔。\n");

        // 语料里还有肉鸽篇 ro2_1（说话人凯尔希）也含相邻的「凯尔」。
        let expected = vec![
            "Obt/Roguelike/ro2/ro2_1".to_string(),
            "kana_story".to_string(),
        ];
        let scanned = sorted_ids(&fx.service.search_stories("\"凯尔\"").unwrap());
        assert_eq!(scanned, expected);

        fx.service.rebuild_story_index().expect("index builds");
        let indexed = sorted_ids(&fx.service.search_stories("\"凯尔\"").unwrap());
        assert_eq!(indexed, expected);
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
        let preview = fx.service.preview_for(content, &terms);
        assert!(preview.contains("凯尔希"), "{}", preview);

        // 一个字都对不上时给开头预览，而不是一个空字符串。
        let terms = split_query_terms("缄默");
        let preview = fx.service.preview_for(content, &terms);
        assert!(!preview.trim().is_empty());
    }

    #[test]
    fn preview_centres_on_whichever_positive_term_hit() {
        let fx = Fixture::new("preview_or");
        let filler = "这是一段很长的开场白。".repeat(30);

        // OR 组命中的是第二个备选：预览必须围绕「阿米娅」，而不是因为
        // 第一个词落空就退回开头片段（±50 字符的窗口根本罩不到结尾）。
        let content = format!("{}阿米娅终于登场了。", filler);
        let terms = split_query_terms("凯尔希 or 阿米娅");
        let preview = fx.service.preview_for(&content, &terms);
        assert!(preview.contains("阿米娅"), "{}", preview);

        // 整词优先于单字原子：第一个词只有零散单字、第二个词整词命中时，
        // 选整词片段——单字碎片远不如整词命中可读。
        let scattered = format!("凯字打头。{}博士在结尾。", filler);
        let terms = split_query_terms("凯尔希 博士");
        let preview = fx.service.preview_for(&scattered, &terms);
        assert!(preview.contains("博士"), "{}", preview);
    }

    /// 段命中恰好填满上限时，被挤掉的标题伪命中必须计入 total 并承认截断。
    /// 以前 total 只报段落 COUNT、truncated 按 `total > LIMIT` 判——两者都
    /// 看不见被 `take(remaining=0)` 丢掉的标题命中，UI 显示的总数看起来
    /// 「一条不少」，实际「雪原」的标题命中根本没进列表。
    #[test]
    fn segment_search_admits_title_hits_dropped_by_the_limit() {
        let fx = Fixture::new("seg_trunc");
        // 全库恰好 SEARCH_RESULT_LIMIT 段命中「雪」：活动篇 1 段（标题
        // 「雪原」另产生一条标题伪命中）+ 长篇 LIMIT-1 段。说话人甲/乙
        // 交替，防止连续同名对白被合并成一段。
        let mut long_story = String::new();
        for i in 0..(SEARCH_RESULT_LIMIT - 1) {
            let speaker = if i % 2 == 0 { "甲" } else { "乙" };
            long_story.push_str(&format!("[name=\"{}\"]第{}夜的雪。\n", speaker, i));
        }
        fx.set_review_table(&format!(
            "{{\"act_1\":{{\"id\":\"act_1\",\"name\":\"骑兵与猎人\",\"entryType\":\"ACTIVITY\",\
              \"actType\":\"ACTIVITY_STORY\",\"infoUnlockDatas\":[{}]}},\
              \"main_0\":{{\"id\":\"main_0\",\"name\":\"黑暗时代\",\"entryType\":\"MAINLINE\",\
              \"infoUnlockDatas\":[{}]}}}}",
            entry_json(
                "act1_st01",
                "雪原",
                "act_1",
                1,
                "activities/act1/act1_st01",
                "",
            ),
            entry_json(
                "long_night",
                "长夜",
                "main_0",
                1,
                "obt/main/level_main_night",
                "LN-1",
            )
        ));
        fx.write_story("obt/main/level_main_night", &long_story);
        fx.service.rebuild_story_index().expect("index builds");

        let page = fx.service.search_segments("雪").unwrap();
        assert_eq!(page.hits.len(), SEARCH_RESULT_LIMIT);
        assert_eq!(
            page.total_matched,
            SEARCH_RESULT_LIMIT + 1,
            "被挤掉的标题命中必须计入总数"
        );
        assert!(page.truncated, "有命中没进列表就必须承认截断");

        // 对照：没截断时 total 就是列表长度。
        let page = fx.service.search_segments("雪很大").unwrap();
        assert_eq!(page.total_matched, page.hits.len());
        assert!(!page.truncated);
    }

    #[test]
    fn title_jump_count_is_not_capped_before_post_filtering() {
        let fx = Fixture::new("title_count");
        let entries = (0..60)
            .map(|idx| {
                entry_json(
                    &format!("title_{idx:02}"),
                    &format!("共同标题 {idx:02}"),
                    "main_titles",
                    idx,
                    &format!("obt/main/title_{idx:02}"),
                    "",
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        fx.set_review_table(&format!(
            "{{\"main_titles\":{{\"id\":\"main_titles\",\"name\":\"标题集\",\
             \"entryType\":\"MAINLINE\",\"infoUnlockDatas\":[{entries}]}}}}"
        ));
        for idx in 0..60 {
            fx.write_story(
                &format!("obt/main/title_{idx:02}"),
                &format!("第 {idx} 篇正文没有检索词。\n"),
            );
        }
        fx.service.rebuild_story_index().expect("index builds");

        let page = fx.service.search_segments("共同标题").unwrap();
        assert_eq!(page.hits.len(), 60);
        assert_eq!(page.total_matched, 60);
        assert!(!page.truncated);
        assert!(
            page.hits.iter().all(|hit| hit.match_target == "title"),
            "all matches come from story titles"
        );
    }

    #[test]
    fn failed_count_at_the_limit_never_claims_complete_results() {
        assert_eq!(
            resolve_limited_match_total(SEARCH_RESULT_LIMIT, Some(SEARCH_RESULT_LIMIT)),
            (SEARCH_RESULT_LIMIT, false)
        );
        assert_eq!(
            resolve_limited_match_total(SEARCH_RESULT_LIMIT, Some(SEARCH_RESULT_LIMIT + 9)),
            (SEARCH_RESULT_LIMIT + 9, false)
        );
        assert_eq!(
            resolve_limited_match_total(SEARCH_RESULT_LIMIT, None),
            (SEARCH_RESULT_LIMIT, true),
            "COUNT failure leaves an honest lower bound and uncertain truncation"
        );
    }

    /// 多词查询的段落预览：整串探针（词与词直接相邻）几乎必落空，必须
    /// 退回逐词探针把片段对准命中的词；长段落裁头 240 字的旧行为会让段尾
    /// 的命中在自己的预览里消失。
    #[test]
    fn segment_preview_centres_on_the_term_that_hit() {
        let fx = Fixture::new("seg_preview");
        let filler = "这是一段很长的旁白。".repeat(40);
        fx.write_story(
            "activities/act1/act1_st01",
            &format!("{}凯尔希与阿米娅出发了。\n", filler),
        );
        fx.service.rebuild_story_index().expect("index builds");

        let page = fx.service.search_segments("凯尔希 出发").unwrap();
        let hit = page
            .hits
            .iter()
            .find(|h| h.story_id == "act1_st01")
            .expect("长旁白段必须命中");
        assert!(
            hit.matched_text.contains("凯尔希"),
            "预览必须包含命中的词，实际: {}",
            hit.matched_text
        );
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
    fn index_connections_install_a_five_second_busy_timeout() {
        let fx = Fixture::new("index_busy_timeout");
        let conn = fx.service.open_index_connection().unwrap();
        let timeout: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(timeout, 5000);
    }

    #[test]
    fn locked_mismatched_index_is_read_only_not_ready_and_falls_back() {
        let fx = Fixture::new("index_locked_mismatch");
        fx.service.rebuild_story_index().expect("index builds");

        // Commit an unknown schema version, then keep a separate write
        // transaction open. The old read path called init_index_tables here,
        // tried to DROP/CREATE both FTS tables, and surfaced SQLITE_BUSY.
        let mut writer = fx.service.open_index_connection().unwrap();
        writer
            .execute(
                "UPDATE story_index_meta SET value = ?1 WHERE key = 'index_version'",
                params![(INDEX_VERSION + 1).to_string()],
            )
            .unwrap();
        let tx = writer.transaction().unwrap();
        tx.execute(
            "INSERT OR REPLACE INTO story_index_meta (key, value) VALUES ('writer_lock', 'held')",
            [],
        )
        .unwrap();

        let status = fx
            .service
            .get_story_index_status()
            .expect("a busy reader must degrade, not error");
        assert!(!status.ready);

        let stories = fx
            .service
            .search_stories_ex("凯尔希")
            .expect("story search must fall back instead of returning SQLITE_BUSY");
        assert!(!stories.index_used);
        assert!(
            stories
                .results
                .iter()
                .any(|result| result.story_id == "main_00-01"),
            "linear scan should still search the installed dataset"
        );

        let segments = fx
            .service
            .search_segments("凯尔希")
            .expect("segment search must return a not-ready page, not SQLITE_BUSY");
        assert!(!segments.index_used);
        assert!(segments.hits.is_empty());

        // No read request may have migrated the database behind our back.
        let version: String = tx
            .query_row(
                "SELECT value FROM story_index_meta WHERE key = 'index_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, (INDEX_VERSION + 1).to_string());
    }

    #[test]
    fn failed_rebuild_emits_a_terminal_failure_phase() {
        let fx = Fixture::new("index_failure_progress");
        fs::remove_file(fx.excel().join("story_review_table.json")).unwrap();
        let events = Mutex::new(Vec::<(String, usize, usize, String)>::new());

        let err = fx
            .service
            .rebuild_story_index_emitting(|phase, current, total, message| {
                events.lock().unwrap().push((
                    phase.to_string(),
                    current,
                    total,
                    message.to_string(),
                ));
            })
            .expect_err("missing dataset must fail rebuilding");
        assert_eq!(err, "NOT_INSTALLED");

        let events = events.into_inner().unwrap();
        let terminal = events.last().expect("failure must emit a terminal event");
        assert_eq!(terminal.0, "失败");
        assert_eq!((terminal.1, terminal.2), (0, 0));
        assert!(terminal.3.contains("NOT_INSTALLED"));
    }

    #[test]
    fn search_pages_report_whether_fts_produced_the_results() {
        let fx = Fixture::new("index_used");

        let scanned = fx.service.search_stories_ex("凯尔希").unwrap();
        assert!(
            !scanned.index_used,
            "linear scan must report indexUsed=false"
        );
        let unavailable_segments = fx.service.search_segments("凯尔希").unwrap();
        assert!(!unavailable_segments.index_used);

        fx.service.rebuild_story_index().expect("index builds");
        let indexed = fx.service.search_stories_ex("凯尔希").unwrap();
        assert!(
            indexed.index_used,
            "successful MATCH must report indexUsed=true"
        );
        let indexed_segments = fx.service.search_segments("凯尔希").unwrap();
        assert!(indexed_segments.index_used);

        // A pure-negative query is an intentional empty short-circuit; no
        // MATCH statement ran even though the index itself is healthy.
        assert!(!fx.service.search_stories_ex("-凯尔希").unwrap().index_used);
        assert!(!fx.service.search_segments("   ").unwrap().index_used);
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
        fx.service
            .rebuild_story_index()
            .expect("rebuild after sync");
        assert_eq!(index_build_count(&db) - before, 2);

        // 索引被清掉（同步/导入会清）之后同样必须重建。
        fx.service.clear_story_index().expect("clear");
        fx.service
            .rebuild_story_index()
            .expect("rebuild after clear");
        assert_eq!(index_build_count(&db) - before, 3);

        let status = fx.service.get_story_index_status().unwrap();
        assert!(status.ready);
        assert_eq!(status.total, 6);
    }

    #[test]
    fn future_index_version_is_recreated_instead_of_reused() {
        let conn = Connection::open_in_memory().unwrap();
        DataService::init_index_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO story_index (
                story_id, story_name, category, tokenized_content, story_code, raw_content
             ) VALUES ('future-row', 'future', '', 'future', '', 'future')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE story_index_meta SET value = ?1 WHERE key = 'index_version'",
            params![(INDEX_VERSION + 1).to_string()],
        )
        .unwrap();

        DataService::init_index_tables(&conn).unwrap();
        let version = DataService::extract_meta_value(&conn, "index_version")
            .unwrap()
            .unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM story_index", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, INDEX_VERSION.to_string());
        assert_eq!(
            rows, 0,
            "unknown newer schemas must be rebuilt from scratch"
        );
    }

    /// 换包与清库不是一个原子操作：若进程恰好在新数据目录换入后、旧索引
    /// 删除前退出，磁盘上会留下「新语料 + 旧索引」。索引指纹已经能识别
    /// 这种状态，所有读路径都必须真的使用它：剧情检索回退扫描、COUNT
    /// 拒答、段落检索拒绝旧命中，状态则触发自动重建。
    #[test]
    fn stale_index_is_rejected_after_dataset_swap() {
        let fx = Fixture::new("index_stale_after_swap");
        fx.service.rebuild_story_index().expect("first build");

        // 模拟新包已经换入而 clear_story_index 尚未执行：版本与脚本都已更新，
        // 索引仍是 commit-1 的「凯尔希：博士，你醒了」。
        fx.set_version("commit-2");
        fx.write_story(
            "obt/main/level_main_00-01",
            "[name=\"华法琳\"]这是新数据包。\n",
        );

        let status = fx.service.get_story_index_status().unwrap();
        assert!(!status.ready, "旧数据集的索引不该被报成 ready");
        assert_eq!(status.total, 0, "不得泄漏旧数据集的篇数");
        assert!(
            status.last_built_at.is_none(),
            "不得把旧数据集的构建时间当作当前状态"
        );
        assert_eq!(
            fx.service.count_fts_matches("华法琳").unwrap(),
            None,
            "旧索引给不出当前数据集的权威总数"
        );
        assert!(
            fx.service
                .search_stories_with_index("华法琳")
                .unwrap()
                .is_none(),
            "剧情检索必须拒绝旧数据集的索引"
        );
        let scanned = fx.service.search_stories("华法琳").unwrap();
        assert!(
            scanned.iter().any(|hit| hit.story_id == "main_00-01"),
            "拒绝旧索引后必须回退扫描当前数据集"
        );
        let stale_segments = fx.service.search_segments("博士，你醒了").unwrap();
        assert!(
            stale_segments.hits.is_empty(),
            "段落检索不得泄漏旧数据集的命中"
        );

        fx.service
            .rebuild_story_index()
            .expect("current dataset rebuilds");
        assert!(fx.service.get_story_index_status().unwrap().ready);
        assert_eq!(fx.service.count_fts_matches("华法琳").unwrap(), Some(1));
        let current_segments = fx.service.search_segments("华法琳").unwrap();
        assert!(
            current_segments
                .hits
                .iter()
                .any(|hit| hit.story_id == "main_00-01"),
            "重建后段落检索必须命中新数据集"
        );
    }

    /// 索引库文件损坏（半截写入、坏块——open 时 PRAGMA 就报 "file is
    /// not a database"）：搜索路径静默回退扫描没问题，但重建以前直接把
    /// 打开错误抛出去——除了整包重新同步没有任何路径会清掉坏库，
    /// 「重建索引」按钮从此永远失败。重建必须自愈：清掉坏库、从头建好。
    #[test]
    fn rebuild_self_heals_a_corrupt_index_database() {
        let fx = Fixture::new("index_corrupt");
        fs::write(&fx.service.index_db_path, b"definitely not a sqlite file").unwrap();

        // 坏库不该让搜索报错：回退扫描照常给结果。
        let scanned = sorted_ids(&fx.service.search_stories("凯尔希").unwrap());
        assert_eq!(
            scanned,
            vec![
                "Obt/Roguelike/ro2/ro2_1".to_string(),
                "main_00-01".to_string()
            ]
        );

        fx.service
            .rebuild_story_index()
            .expect("重建必须清掉损坏的索引库并自愈");

        let status = fx.service.get_story_index_status().unwrap();
        assert!(status.ready);
        assert_eq!(status.total, 6);
        // 自愈后的索引真的在工作：FTS 路径可用、命中总数权威，且与扫描一致。
        assert_eq!(fx.service.count_fts_matches("凯尔希").unwrap(), Some(2));
        let indexed = fx
            .service
            .search_stories_with_index("凯尔希")
            .unwrap()
            .expect("自愈后索引路径必须可用");
        assert_eq!(sorted_ids(&indexed), scanned);
    }

    /// 上一条测的是「open 时就报错」的坏库；这条测坏块只落在 FTS 内容页
    /// 上的库：open、建表、剧情表查询全都正常，损坏要到重建的清表/灌入
    /// 阶段才第一次暴露（vtable constructor failed）。以前这类库有两重
    /// 死局：状态照报 ready（前端永远不来触发重建），手动重建又每次都
    /// 失败在同一处。状态必须承认不可用，重建必须清库自愈。
    #[test]
    fn rebuild_self_heals_when_corruption_surfaces_mid_build() {
        let fx = Fixture::new("index_tail_corrupt");
        fx.service.rebuild_story_index().expect("first build");
        // 开一次连接再关掉：最后一个连接关闭时 WAL 会 checkpoint 回主文件，
        // 之后的字节级破坏才真的落在库本体上。
        drop(fx.service.open_index_connection().unwrap());

        // 只破坏文件尾部（FTS 内容页），保住文件头、schema 和 meta 页，
        // open 与建表都探不出病。
        let db = fx.service.index_db_path.clone();
        let len = fs::metadata(&db).unwrap().len();
        assert!(len > 16384, "库文件太小，破坏窗口会伤到 schema 页");
        use std::io::{Seek, SeekFrom};
        let mut file = fs::OpenOptions::new().write(true).open(&db).unwrap();
        file.seek(SeekFrom::Start(len - 16384)).unwrap();
        file.write_all(&vec![0xAAu8; 16384]).unwrap();
        file.sync_all().unwrap();
        drop(file);
        // 干掉 WAL/SHM，别让 SQLite 从日志里把好页找回来。
        for suffix in ["-wal", "-shm"] {
            let mut path = db.clone().into_os_string();
            path.push(suffix);
            let _ = fs::remove_file(PathBuf::from(path));
        }

        // 状态不能撒谎：段落表连 COUNT 都跑不动的库不算 ready——报 ready
        // 的话 useAutoIndex 永远不会来触发重建，段落检索一直静默空页。
        let status = fx.service.get_story_index_status().unwrap();
        assert!(!status.ready, "损坏的段落表不该被报成 ready");

        // 数据集更新后自动重建：必须清掉坏库从头建好，而不是永远失败。
        fx.set_version("commit-2");
        fx.service
            .rebuild_story_index()
            .expect("写入阶段才暴露的损坏必须清库自愈");

        let status = fx.service.get_story_index_status().unwrap();
        assert!(status.ready);
        assert_eq!(status.total, 6);
        let indexed = fx
            .service
            .search_stories_with_index("凯尔希")
            .unwrap()
            .expect("自愈后索引路径必须可用");
        assert_eq!(
            sorted_ids(&indexed),
            vec![
                "Obt/Roguelike/ro2/ro2_1".to_string(),
                "main_00-01".to_string()
            ]
        );
    }

    /// 前两条测的都是「会报错」的坏库；这条测**失忆**的库：倒排索引住在
    /// `*_data` 影子表里，坏块把它抹成零后，全零的结构记录会被解码成
    /// 「合法的空索引」——schema、COUNT、MATCH 全都不报错，只是查什么都
    /// 静默返回空集（COUNT 走 `*_content`，行数照旧）。以前这形态三处
    /// 一起撒谎：搜索把空集当权威结果返回（不回退扫描）、状态照报 ready
    /// （useAutoIndex 永远不来）、重建看指纹和行数都对得上直接跳过——
    /// 比报错的坏库更隐蔽的永久死局。
    #[test]
    fn amnesiac_index_falls_back_to_scan_and_rebuild_heals_it() {
        let fx = Fixture::new("index_amnesia");
        fx.service.rebuild_story_index().expect("first build");
        let db = fx.service.index_db_path.clone();
        let before = index_build_count(&db);

        // 只抹掉剧情表的倒排索引（*_data），内容影子表保持完好——模拟
        // 坏块恰好落在索引页上的形态。SQL 层动手，库文件本身依旧健康。
        {
            let conn = fx.service.open_index_connection().unwrap();
            conn.execute_batch("UPDATE story_index_data SET block = zeroblob(length(block));")
                .unwrap();
        }

        // 状态不能撒谎：查不到自己内容的索引不算 ready。
        let status = fx.service.get_story_index_status().unwrap();
        assert!(!status.ready, "失忆的索引不该被报成 ready");

        // 搜索不能把失忆索引的空集当权威结果，必须回退线性扫描。
        let scanned = sorted_ids(&fx.service.search_stories("凯尔希").unwrap());
        assert_eq!(
            scanned,
            vec![
                "Obt/Roguelike/ro2/ro2_1".to_string(),
                "main_00-01".to_string()
            ]
        );

        // 指纹没变也必须重建：行数对得上不代表倒排索引还认识这些行。
        fx.service
            .rebuild_story_index()
            .expect("失忆索引必须能重建自愈");
        assert_eq!(
            index_build_count(&db) - before,
            1,
            "失忆索引不得被当成「已是最新」跳过"
        );

        let status = fx.service.get_story_index_status().unwrap();
        assert!(status.ready);
        assert_eq!(status.total, 6);
        let indexed = fx
            .service
            .search_stories_with_index("凯尔希")
            .unwrap()
            .expect("自愈后索引路径必须可用");
        assert_eq!(sorted_ids(&indexed), scanned);
    }

    /// 失忆库的段落表变体。段落检索没有线性扫描兜底，状态与重建就是它
    /// 唯一的生路：状态必须承认未就绪（useAutoIndex 才会来触发重建），
    /// 重建必须无视「指纹相符 + 行数相符」真的重建。
    #[test]
    fn amnesiac_segment_index_is_rebuilt_not_skipped() {
        let fx = Fixture::new("segment_amnesia");
        fx.service.rebuild_story_index().expect("first build");
        let db = fx.service.index_db_path.clone();
        let before = index_build_count(&db);

        {
            let conn = fx.service.open_index_connection().unwrap();
            conn.execute_batch(
                "UPDATE story_segment_index_data SET block = zeroblob(length(block));",
            )
            .unwrap();
        }

        let status = fx.service.get_story_index_status().unwrap();
        assert!(!status.ready, "段落表失忆的索引不该被报成 ready");

        // 失忆期间的段落检索给不出真结果，但绝不能报错吓退调用方。
        let page = fx.service.search_segments("凯尔希").unwrap();
        assert!(page.hits.is_empty());

        fx.service
            .rebuild_story_index()
            .expect("失忆的段落表必须能重建自愈");
        assert_eq!(
            index_build_count(&db) - before,
            1,
            "失忆的段落表不得被当成「已是最新」跳过"
        );

        let page = fx.service.search_segments("凯尔希").unwrap();
        assert!(!page.hits.is_empty(), "自愈后段落检索必须真的有命中");
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

        // version.json 被断电截成半截（解析失败）或干脆缺失，但数据集
        // 还完整：同样没有可比 commit，不能催更。
        fs::write(fx.service.data_dir.join(VERSION_FILE), "{\"commit\":").unwrap();
        assert_eq!(
            fx.service.check_update().unwrap(),
            false,
            "a corrupt version file with an intact dataset must not report an update"
        );
        fs::remove_file(fx.service.data_dir.join(VERSION_FILE)).unwrap();
        assert_eq!(
            fx.service.check_update().unwrap(),
            false,
            "a missing version file with an intact dataset must not report an update"
        );

        // 完全没有数据时才提示用户下载。
        fs::remove_dir_all(&fx.service.data_dir).unwrap();
        assert!(fx.service.check_update().unwrap());
    }

    /// version.json 缺失/损坏但数据集完整时，设置页不能显示「未安装」催用户
    /// 首次下载——和 check_update 堵住的是同一类撒谎；数据目录真不在才算未安装。
    #[test]
    fn current_version_only_reports_not_installed_when_dataset_is_gone() {
        let fx = Fixture::new("cur_ver");

        // 正常路径：version.json 可读，展示短 commit + 时间。
        fx.set_version("abcdef1234567890");
        assert!(
            fx.service
                .get_current_version()
                .unwrap()
                .starts_with("abcdef1"),
            "可读版本文件应展示短 commit"
        );

        // 损坏（断电截成半截）：数据集还在，不能报「未安装」。
        fs::write(fx.service.data_dir.join(VERSION_FILE), "{\"commit\":").unwrap();
        assert_eq!(
            fx.service.get_current_version().unwrap(),
            "本地数据（版本未知）",
            "版本文件损坏但数据完整，不能报「未安装」"
        );

        // 缺失（换入后写版本失败）：同样不能报「未安装」。
        fs::remove_file(fx.service.data_dir.join(VERSION_FILE)).unwrap();
        assert_eq!(
            fx.service.get_current_version().unwrap(),
            "本地数据（版本未知）",
            "版本文件缺失但数据完整，不能报「未安装」"
        );

        // 数据目录整个不存在，才是真正的「未安装」。
        fs::remove_dir_all(&fx.service.data_dir).unwrap();
        assert_eq!(fx.service.get_current_version().unwrap(), "未安装");
    }

    // ---- Version file durability --------------------------------------------

    /// write_version 走「同目录临时文件 + rename」：写完必须能原样读回（首次
    /// 创建和覆盖旧文件都走 rename 替换），且成功路径不残留 .tmp 文件。
    #[test]
    fn write_version_round_trips_and_leaves_no_temp_files() {
        let fx = Fixture::new("ver_atomic");

        let info = VersionInfo {
            commit: "abcdef1234567890".to_string(),
            fetched_at: 1_700_000_000,
        };
        fx.service.write_version(&info).expect("write version");
        let read = fx
            .service
            .read_version()
            .expect("must read back what was just written");
        assert_eq!(read.commit, info.commit);
        assert_eq!(read.fetched_at, info.fetched_at);

        let newer = VersionInfo {
            commit: "1234567890abcdef".to_string(),
            fetched_at: 1_700_000_001,
        };
        fx.service.write_version(&newer).expect("overwrite version");
        assert_eq!(fx.service.read_version().unwrap().commit, newer.commit);

        let leftovers: Vec<String> = fs::read_dir(&fx.service.data_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留的临时文件: {:?}", leftovers);
    }

    /// 模拟断电发生在 rename 之前：磁盘上只有半截临时文件，正式 version.json
    /// 不存在。read_version 必须是 None，get_current_version 走「版本未知」，
    /// check_update 不催更——绝不能把半截 JSON 当版本解析。残留的旧临时文件
    /// 也不能妨碍下一次正常写入。
    #[test]
    fn half_written_temp_file_is_not_mistaken_for_the_version_file() {
        let fx = Fixture::new("ver_tmp_only");

        // Fixture 自带一份正式 version.json，先删掉才是「rename 前断电」现场。
        fs::remove_file(fx.service.version_file_path()).unwrap();
        let stale_tmp = fx
            .service
            .data_dir
            .join(format!(".{}.12345.67890.tmp", VERSION_FILE));
        fs::write(&stale_tmp, "{\"commit\":\"abc").unwrap();

        assert!(
            fx.service.read_version().is_none(),
            "只有临时文件时不能读出版本"
        );
        assert_eq!(
            fx.service.get_current_version().unwrap(),
            "本地数据（版本未知）",
            "数据集完整、只剩半截临时文件，应报「版本未知」而非解析它"
        );
        assert_eq!(
            fx.service.check_update().unwrap(),
            false,
            "数据集完整、版本未知，不能催更"
        );

        let info = VersionInfo {
            commit: "fedcba0987654321".to_string(),
            fetched_at: 1_700_000_002,
        };
        fx.service
            .write_version(&info)
            .expect("write after stale tmp");
        assert_eq!(fx.service.read_version().unwrap().commit, info.commit);
    }

    /// version.json 是用户可手工编辑的文件：commit 填非 ASCII、fetched_at
    /// 填负数都能通过 JSON 解析。get_current_version 曾按字节切
    /// `commit[..7]`（字节 7 落在多字节字符中间直接 panic），又把负时间戳
    /// `as u64` 回绕后加到 EPOCH 上（SystemTime 加法溢出 panic）。这种文件
    /// 顶多显示得难看，绝不能把命令炸掉。
    #[test]
    fn hand_edited_version_file_never_panics_current_version() {
        let fx = Fixture::new("ver_hand_edit");

        // 「版本未知版本未知」的字符边界在 0/3/6/9…，字节 7 不是边界。
        Fixture::write_file(
            &fx.service.version_file_path(),
            "{\"commit\":\"版本未知版本未知\",\"fetched_at\":-1}",
        );
        let shown = fx.service.get_current_version().unwrap();
        assert!(
            shown.starts_with("版本未知版本未"),
            "取前 7 个字符而非前 7 字节: {}",
            shown
        );
        assert!(shown.contains("较早前"), "负时间戳按太久远显示: {}", shown);

        // 常规 ASCII commit 行为不变：仍取前 7 位十六进制。
        fx.set_version("abcdef1234567890");
        assert!(
            fx.service
                .get_current_version()
                .unwrap()
                .starts_with("abcdef1"),
            "ASCII commit 仍显示前 7 位"
        );
    }

    /// short_commit 的边界：恰好 7 字符原样返回、不足 7 字符原样返回、
    /// 超过则截到第 7 个字符（无论单字节还是多字节）。
    #[test]
    fn short_commit_truncates_on_char_boundaries() {
        assert_eq!(short_commit("abcdef1"), "abcdef1");
        assert_eq!(short_commit("abc"), "abc");
        assert_eq!(short_commit(""), "");
        assert_eq!(short_commit("abcdef1234"), "abcdef1");
        assert_eq!(short_commit("版本未知版本未知"), "版本未知版本未");
    }

    // ---- ZIP install safety ------------------------------------------------

    fn write_zip(path: &Path, entries: &[(&str, &str)]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
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
    fn extract_rejects_nonempty_but_truncated_review_json() {
        let fx = Fixture::new("zip_truncated_json");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let zip_path = parent.join("truncated-json.zip");
        write_zip(
            &zip_path,
            &[
                (
                    "pkg/zh_CN/gamedata/excel/story_review_table.json",
                    "{\"main_0\":",
                ),
                (
                    "pkg/zh_CN/gamedata/story/obt/main/level_main_00-01.txt",
                    "文本",
                ),
            ],
        );

        let err = fx
            .service
            .extract_zip_at(&zip_path, &parent, None)
            .expect_err("non-empty truncated JSON must not replace live data");
        assert!(err.contains("不是完整 JSON"), "{err}");
        assert_eq!(
            fx.service.get_story_entry("main_00-01").unwrap().story_name,
            "序章",
            "rejected package must preserve the previous dataset"
        );
    }

    #[test]
    fn extract_rejects_catalog_without_any_corresponding_script() {
        let fx = Fixture::new("zip_no_scripts");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let zip_path = parent.join("no-scripts.zip");
        write_zip(
            &zip_path,
            &[(
                "pkg/zh_CN/gamedata/excel/story_review_table.json",
                REVIEW_TABLE_JSON,
            )],
        );

        let err = fx
            .service
            .extract_zip_at(&zip_path, &parent, None)
            .expect_err("a table-only package cannot serve the reader");
        assert!(err.contains("缺少与目录表对应的非空脚本"), "{err}");
        assert!(fx.service.is_installed(), "old data must remain usable");
    }

    /// 压根不是 ZIP 的文件（半截下载）：打开归档就失败。失败路径必须
    /// 清掉刚建好的解压暂存目录——用户放弃重试时它不该赖在磁盘上。
    #[test]
    fn extract_cleans_staging_when_archive_is_unreadable() {
        let fx = Fixture::new("zip_garbage");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let zip_path = parent.join("garbage.zip");
        fs::write(&zip_path, b"this is not a zip archive").unwrap();

        assert!(fx.service.extract_zip_at(&zip_path, &parent, None).is_err());
        assert!(
            !parent.join("ArknightsGameData_extract").exists(),
            "打开归档失败后不得留下解压暂存目录"
        );
        assert!(fx.service.is_installed(), "失败不能伤及现有数据");
    }

    /// 解压中途出错（这里用「同名路径先是文件后当目录」制造确定性的 IO
    /// 失败，现实中对应磁盘满/坏包）：已经解出来的半截树可达上百 MB，
    /// 失败后必须整个清掉，不能等下一次同步开场才收尸。
    #[test]
    fn extract_cleans_staging_when_extraction_fails_midway() {
        let fx = Fixture::new("zip_midfail");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let zip_path = parent.join("midfail.zip");
        write_zip(
            &zip_path,
            &[
                ("pkg/conflict", "occupies the path as a file"),
                ("pkg/conflict/child.txt", "needs conflict to be a directory"),
            ],
        );

        let err = fx
            .service
            .extract_zip_at(&zip_path, &parent, None)
            .expect_err("路径冲突的包必须解压失败");
        assert!(!err.is_empty());
        assert!(
            !parent.join("ArknightsGameData_extract").exists(),
            "解压中途失败后不得留下半截暂存树"
        );
        assert!(fx.service.is_installed(), "失败不能伤及现有数据");
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
                (
                    "pkg/zh_CN/gamedata/story/obt/main/level_main_00-01.txt",
                    "文本",
                ),
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

    /// macOS 的压缩工具会给包塞一个 __MACOSX 伴生目录。选数据根不能盲选
    /// read_dir 返回的第一个目录——必须认准装着有效数据集的那一个。
    #[test]
    fn extract_skips_macosx_sibling_dir() {
        let fx = Fixture::new("zip_macosx");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let zip_path = parent.join("macosx.zip");
        write_zip(
            &zip_path,
            &[
                // 伴生目录写在前面：无论 read_dir 先读到谁都不能选错。
                ("__MACOSX/pkg/._story_review_table.json", "AppleDouble junk"),
                (
                    "pkg/zh_CN/gamedata/excel/story_review_table.json",
                    REVIEW_TABLE_JSON,
                ),
                (
                    "pkg/zh_CN/gamedata/story/obt/main/level_main_00-01.txt",
                    "文本",
                ),
            ],
        );

        fx.service
            .extract_zip_at(&zip_path, &parent, None)
            .expect("__MACOSX 伴生目录不该挡住有效数据集");

        assert!(fx.service.is_installed());
        assert_eq!(
            fx.service.get_story_entry("main_00-01").unwrap().story_name,
            "序章"
        );
        assert!(
            !fx.service.data_dir.join("__MACOSX").exists(),
            "伴生目录不该跟着数据集一起换进来"
        );
        assert!(!parent.join("ArknightsGameData_extract").exists());
    }

    /// 有的包不带顶层目录，zh_CN 直接躺在压缩包根部。此时解压根本身就是
    /// 数据集根，不能再钻进子目录里找。
    #[test]
    fn extract_accepts_dataset_at_archive_root() {
        let fx = Fixture::new("zip_rootset");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let zip_path = parent.join("rootset.zip");
        write_zip(
            &zip_path,
            &[
                (
                    "zh_CN/gamedata/excel/story_review_table.json",
                    REVIEW_TABLE_JSON,
                ),
                ("zh_CN/gamedata/story/obt/main/level_main_00-01.txt", "文本"),
            ],
        );

        fx.service
            .extract_zip_at(&zip_path, &parent, None)
            .expect("zh_CN 在压缩包根部的包也必须能装");

        assert!(fx.service.is_installed());
        assert!(fx
            .service
            .data_dir
            .join("zh_CN/gamedata/story/obt/main/level_main_00-01.txt")
            .exists());
        assert!(!parent.join("ArknightsGameData_extract").exists());
    }

    /// 常规布局：数据集在唯一的顶层子目录里。换入的应是子目录的内容，
    /// 而不是外层解压目录（否则会多嵌套一层）。
    #[test]
    fn extract_finds_dataset_in_single_child_dir() {
        let fx = Fixture::new("zip_child");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let zip_path = parent.join("child.zip");
        write_zip(
            &zip_path,
            &[
                (
                    "ArknightsGameData-master/zh_CN/gamedata/excel/story_review_table.json",
                    REVIEW_TABLE_JSON,
                ),
                (
                    "ArknightsGameData-master/zh_CN/gamedata/story/obt/main/level_main_00-01.txt",
                    "文本",
                ),
            ],
        );

        fx.service
            .extract_zip_at(&zip_path, &parent, None)
            .expect("数据集在唯一子目录里的常规包必须能装");

        assert!(fx.service.is_installed());
        assert!(
            !fx.service
                .data_dir
                .join("ArknightsGameData-master")
                .exists(),
            "换入的是子目录内容，不该嵌套一层"
        );
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
            &[
                (
                    "pkg/zh_CN/gamedata/excel/story_review_table.json",
                    review_without_mainline,
                ),
                (
                    "pkg/zh_CN/gamedata/story/activities/act1/act1_st01.txt",
                    "新活动正文",
                ),
            ],
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

    /// 旧数据连 `_old` 都挪不动时必须原地不动、直接失败。旧实现会退回
    /// remove_dir_all；父目录只读时它能先删除 data_dir 内全部文件，最后
    /// 删除 data_dir 自身才报 PermissionDenied，形成「命令报错 + 旧数据
    /// 已被掏空 + 没有 `_old`」的不可恢复状态。
    #[cfg(unix)]
    #[test]
    fn swap_never_deletes_old_data_when_it_cannot_be_moved_aside() {
        use std::os::unix::fs::PermissionsExt;

        let fx = Fixture::new("swap_aside_denied");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let old_marker = fx.service.data_dir.join("old-data-must-survive.txt");
        Fixture::write_file(&old_marker, "old");

        let replacement = parent.join("replacement");
        Fixture::write_file(&replacement.join(REVIEW_TABLE_REL), REVIEW_TABLE_JSON);

        let original_mode = fs::metadata(&parent).unwrap().permissions().mode();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o555)).unwrap();
        let result = fx.service.swap_in_extracted(&replacement);
        // 先恢复权限，确保断言失败时测试夹具仍可清理，也避免污染后续测试。
        fs::set_permissions(&parent, fs::Permissions::from_mode(original_mode)).unwrap();

        let err = result.expect_err("旧目录挪不开时换入必须安全失败");
        assert!(
            err.contains("Failed to preserve old data directory"),
            "{}",
            err
        );
        assert!(fx.service.is_installed(), "失败后旧数据集必须仍然完整");
        assert!(old_marker.exists(), "旧目录里的文件一个都不能删");
        assert!(
            replacement.exists(),
            "换入尚未开始，验收完的新树也应原样保留"
        );
        assert!(
            !parent.join("ArknightsGameData_old").exists(),
            "旧目录改名失败时不应伪造出可回滚副本"
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
            &[
                (
                    "pkg/zh_CN/gamedata/excel/story_review_table.json",
                    REVIEW_TABLE_JSON,
                ),
                (
                    "pkg/zh_CN/gamedata/story/obt/main/level_main_00-01.txt",
                    "文本",
                ),
            ],
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

    /// data_dir 只是壳子（空 review 表）而固定名 `_old` 装着唯一完整数据
    /// 副本时，腾暂存名绝不能删 `_old`——那是启动恢复的口粮，此刻新树
    /// 还没落位。必须退化用时间戳名字，且时间戳变体要能被
    /// restore_data_dir_from_aside 的候选扫描解析出来。
    #[test]
    fn aside_path_preserves_only_valid_copy_when_data_dir_is_husk() {
        let fx = Fixture::new("aside_keep_recovery");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();

        // data_dir 变成壳子：review 表清空。
        fs::write(fx.service.data_dir.join(REVIEW_TABLE_REL), "").unwrap();
        // 固定名 `_old` 是唯一完整数据副本。
        let old = parent.join("ArknightsGameData_old");
        Fixture::write_file(&old.join(REVIEW_TABLE_REL), REVIEW_TABLE_JSON);
        Fixture::write_file(&old.join("marker.txt"), "only complete copy");

        let aside = fx.service.old_data_aside_path();

        assert!(
            old.join("marker.txt").exists(),
            "data_dir 是壳子时，装着有效数据的 _old 一个字节都不能动"
        );
        assert_ne!(aside, old, "暂存名必须避开恢复来源");
        let name = aside.file_name().unwrap().to_str().unwrap();
        let stamp = name
            .strip_prefix("ArknightsGameData_old_")
            .expect("退化名必须是固定名加时间戳后缀");
        assert!(
            stamp.parse::<u128>().is_ok(),
            "时间戳后缀必须能被启动恢复的候选扫描解析: {}",
            name
        );
    }

    /// 端到端的危险链路：data_dir 只剩壳子、唯一完整数据在 `_old`（跨设备
    /// 拷贝断电 + 启动恢复清壳失败后的典型现场），用户在同一进程里重试
    /// 同步，而新树又落不了位。修复前 swap_in_extracted 开场就把 `_old`
    /// 删掉腾名字，落位再失败就两头落空；修复后失败归失败，恢复来源必须
    /// 原封不动，且重启后必须还能把旧数据接回来。
    #[test]
    fn failed_swap_on_husk_keeps_recovery_source_for_restart() {
        let fx = Fixture::new("husk_swap_keep");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();

        // 现场布置：完整数据挪进 _old，data_dir 里只留一张空 review 表。
        let old = parent.join("ArknightsGameData_old");
        fs::rename(&fx.service.data_dir, &old).unwrap();
        Fixture::write_file(&fx.service.data_dir.join(REVIEW_TABLE_REL), "");

        // 新目录不存在：rename 和整树拷贝都必然失败，逼出失败路径。
        let missing = parent.join("does_not_exist");
        let err = fx
            .service
            .swap_in_extracted(&missing)
            .expect_err("swapping in a missing tree must fail");
        assert!(!err.is_empty());

        assert!(
            DataService::holds_valid_dataset(&old),
            "换入失败后唯一完整副本必须还完整躺在 _old 里"
        );

        let relaunched = DataService::new(fx.root.clone());
        assert!(
            relaunched.is_installed(),
            "重启后必须能从 _old 把旧数据接回 data_dir"
        );
        assert!(!old.exists(), "恢复即改名回 data_dir，不留副本");
        assert_eq!(
            relaunched.get_story_entry("main_00-01").unwrap().story_name,
            "序章"
        );
    }

    /// 反向护栏：data_dir 本身有效时，装着旧数据集的固定名 `_old` 就是
    /// 上次成功换入后没删掉的陈骸，腾暂存名必须照常回收复用固定名，
    /// 不能因为它「看起来有效」就留着白占一份数据集的磁盘。
    #[test]
    fn aside_path_still_reclaims_stale_valid_old_when_data_dir_is_valid() {
        let fx = Fixture::new("aside_reclaim_stale");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();

        let old = parent.join("ArknightsGameData_old");
        Fixture::write_file(&old.join(REVIEW_TABLE_REL), REVIEW_TABLE_JSON);
        Fixture::write_file(&old.join("marker.txt"), "superseded dataset");

        let aside = fx.service.old_data_aside_path();
        assert_eq!(aside, old, "data_dir 有效时固定名陈骸必须回收复用");
        assert!(!old.exists(), "陈骸必须被当场删掉腾出名字");
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

    /// 跨设备回退拷贝（swap_in_extracted 的 copy_dir_all 分支）中途断电：
    /// data_dir 是个没有 review 表的半截新树，完整旧数据还在 `_old`。
    /// 启动必须清掉壳子、接回旧数据，否则用户明明有完整数据却看到
    /// 「未安装」，而 `_old` 会在下一次换入开场被当陈骸删掉。
    #[test]
    fn new_replaces_invalid_husk_with_valid_aside() {
        let fx = Fixture::new("recover_husk");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let aside = parent.join("ArknightsGameData_old");
        fs::rename(&fx.service.data_dir, &aside).unwrap();
        // 半截新树：拷了一些文件，review 表还没落地。
        Fixture::write_file(
            &fx.service.data_dir.join("zh_CN/gamedata/story/partial.txt"),
            "half copy",
        );
        assert!(!fx.service.is_installed(), "崩溃现场：壳子撑不起应用");

        let relaunched = DataService::new(fx.root.clone());
        assert!(relaunched.is_installed(), "半截壳子必须让位给完整旧数据");
        assert!(!aside.exists(), "恢复即改名回 data_dir，不留副本");
        assert!(
            !relaunched
                .data_dir
                .join("zh_CN/gamedata/story/partial.txt")
                .exists(),
            "壳子的残余不得混进恢复后的数据"
        );
        assert_eq!(
            relaunched.get_story_entry("main_00-01").unwrap().story_name,
            "序章"
        );
    }

    /// 空的 review 表同样是壳子（holds_valid_dataset 要求非空，
    /// is_installed 同尺）：恢复判定不能把它当有效数据留在原地。
    #[test]
    fn new_replaces_husk_with_empty_review_table() {
        let fx = Fixture::new("recover_husk_empty");
        let parent = fx.service.data_dir.parent().unwrap().to_path_buf();
        let aside = parent.join("ArknightsGameData_old");
        fs::rename(&fx.service.data_dir, &aside).unwrap();
        Fixture::write_file(&fx.service.data_dir.join(REVIEW_TABLE_REL), "");

        let relaunched = DataService::new(fx.root.clone());
        assert!(!aside.exists(), "空表壳子必须让位给完整旧数据");
        assert_eq!(
            relaunched.get_story_entry("main_00-01").unwrap().story_name,
            "序章"
        );
    }

    /// 没有可恢复的完整旧数据时，启动绝不能清 data_dir——哪怕它当前
    /// 不是一份有效数据集，删东西没有任何收益，只会雪上加霜。
    #[test]
    fn new_keeps_invalid_data_dir_when_no_valid_aside() {
        let fx = Fixture::new("recover_husk_keep");
        // review 表清空：data_dir 变成无效壳子，且周围没有 _old 候选。
        fs::write(fx.service.data_dir.join(REVIEW_TABLE_REL), "").unwrap();
        Fixture::write_file(&fx.service.data_dir.join("user_note.txt"), "keep me");

        let relaunched = DataService::new(fx.root.clone());
        assert!(
            relaunched.data_dir.join("user_note.txt").exists(),
            "没有恢复来源时不得清理 data_dir"
        );
        assert!(
            relaunched.data_dir.join(REVIEW_TABLE_REL).exists(),
            "壳子里的文件一个都不该动"
        );
    }

    /// 上一场景的用户可见面：首次安装的跨设备拷贝断电后，data_dir 里
    /// 只剩一张 0 字节 review 表，没有 version.json，也没有 `_old` 可
    /// 恢复。安装判定必须与 holds_valid_dataset 同尺——只看 exists()
    /// 会误报「已安装」：check_update 不催下载、前端不弹同步引导、
    /// 设置页说「本地数据」，目录加载却因解析空 JSON 报错，用户卡死
    /// 在坏数据上没有出路。
    #[test]
    fn husk_with_empty_review_table_does_not_count_as_installed() {
        let fx = Fixture::new("husk_not_installed");
        fs::write(fx.service.data_dir.join(REVIEW_TABLE_REL), "").unwrap();
        fs::remove_file(fx.service.data_dir.join(VERSION_FILE)).unwrap();

        assert!(
            !fx.service.is_installed(),
            "0 字节 review 表撑不起应用，不能算「已安装」"
        );
        assert!(
            fx.service.check_update().unwrap(),
            "壳子等于没装，必须提示用户下载数据"
        );
        assert_eq!(
            fx.service.get_current_version().unwrap(),
            "未安装",
            "设置页不能把壳子说成有本地数据"
        );
        let err = fx
            .service
            .get_story_categories()
            .expect_err("壳子上读目录必须走统一的未安装错误");
        assert!(err.contains("NOT_INSTALLED"), "{}", err);
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

    /// 分块导入半途而废会留下 `.part`；转正后、finalize 接手前崩溃会
    /// 留下导入临时 ZIP。重启后两者都没有续传协议，必须一并清理。
    #[test]
    fn new_discards_all_leftover_import_transfer_files() {
        let fx = Fixture::new("staging_cleanup");
        let staging = fx
            .service
            .import_staging_path()
            .expect("必须能推导暂存路径");
        fs::write(&staging, b"abandoned half transfer").unwrap();
        let temp_zip = staging.with_file_name("ArknightsGameData_import.zip");
        fs::write(&temp_zip, b"promoted just before a crash").unwrap();

        let relaunched = DataService::new(fx.root.clone());
        assert!(!staging.exists(), "启动必须清理中断传输留下的暂存文件");
        assert!(
            !temp_zip.exists(),
            "finalize 前崩溃留下的已转正临时 ZIP 也必须清理"
        );
        assert!(relaunched.is_installed(), "清理暂存不得伤及数据目录");
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

    /// 分块导入的暂存文件必须和导入临时 ZIP 同目录（改名不跨文件系统），
    /// 且带 `.part` 后缀标明可能是半截文件。
    #[test]
    fn import_staging_path_sits_next_to_import_temp_zip() {
        let fx = Fixture::new("import_staging_path");
        let staging = fx
            .service
            .import_staging_path()
            .expect("必须能推导暂存路径");
        assert_eq!(
            staging.parent(),
            fx.service.data_dir.parent(),
            "暂存文件必须与导入临时 ZIP 同目录"
        );
        assert_eq!(
            staging.file_name().and_then(|n| n.to_str()),
            Some("ArknightsGameData_import_staging.part")
        );
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
