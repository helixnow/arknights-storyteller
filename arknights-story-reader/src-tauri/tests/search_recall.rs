//! Search recall tests.
//!
//! Two tiers live in this file:
//!
//! 1. **Fixture tier** (always runs). A miniature dataset is written to a temp
//!    directory and searched through the very same code path the app uses when
//!    the FTS index hasn't been built yet — the linear scanner. It needs no
//!    network, no `ArknightsGameData` checkout and no prior app launch, so it
//!    can guard the parser → searchable-text → query-semantics chain on every
//!    `cargo test`. Counts are exact because the corpus is known in full.
//!
//! 2. **Real-corpus tier** (`#[ignore]`). Runs against a synced
//!    ArknightsGameData checkout + `story_index.db` and asserts lower bounds on
//!    hit counts for real-world queries. Run with:
//!
//!        cargo test --test search_recall -- --ignored --nocapture --test-threads=1
//!
//! Purpose of both: guarantee that changes to the parser / tokenizer / query
//! builder do not silently regress what users can find.

use std::path::{Path, PathBuf};

use story_teller_lib::data_service_test::DataServiceHandle;

fn app_data_root() -> Option<PathBuf> {
    // We don't depend on `tauri::api::path` here to avoid pulling in the full
    // Tauri runtime from a plain cargo test — it's just a platform-specific
    // lookup. Hard-code the macOS / Linux / Windows defaults; CI will need an
    // env override if it wants to run these.
    if let Ok(explicit) = std::env::var("ARKNIGHTS_READER_DATA_ROOT") {
        return Some(PathBuf::from(explicit));
    }
    if let Some(home) = dirs_home() {
        if cfg!(target_os = "macos") {
            return Some(home.join("Library/Application Support/com.arknights.storyreader"));
        }
        if cfg!(target_os = "linux") {
            return Some(home.join(".local/share/com.arknights.storyreader"));
        }
        if cfg!(target_os = "windows") {
            return Some(home.join("AppData/Roaming/com.arknights.storyreader"));
        }
    }
    None
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Locate the synced dataset for the `#[ignore]` tier.
///
/// These tests only run when someone asks for them by name or with
/// `--ignored`, so a missing dataset is a setup error, not a reason to report
/// success. Returning early used to make every ignored test pass green
/// without executing a single query.
fn setup() -> DataServiceHandle {
    let root = app_data_root().expect(
        "cannot locate the app data directory — set ARKNIGHTS_READER_DATA_ROOT to the folder \
         containing ArknightsGameData/ and story_index.db",
    );
    assert!(
        root.join("ArknightsGameData").exists(),
        "dataset missing at {:?} — run the app once to sync, or set ARKNIGHTS_READER_DATA_ROOT",
        root
    );
    assert!(
        root.join("story_index.db").exists(),
        "story_index.db missing at {:?} — launch the app once so the index is built, or set \
         ARKNIGHTS_READER_DATA_ROOT",
        root
    );
    DataServiceHandle::new(root)
}

// ---------------------------------------------------------------------------
// Fixture tier — a complete, tiny dataset on disk. No network, no game data.
// ---------------------------------------------------------------------------

/// A throwaway app-data directory holding a six-story dataset. Deleted on drop.
///
/// Layout mirrors a real sync exactly (`ArknightsGameData/zh_CN/gamedata/...`),
/// so `DataService` treats it as installed and the search commands take the
/// production code path. No `story_index.db` is written, which is precisely the
/// state a user is in before the first index build: story search falls back to
/// the linear scanner and segment search reports "index not ready".
struct Fixture {
    root: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("ark_recall_{}_{}", tag, nanos));
        let fixture = Fixture { root };
        fixture.install();
        fixture
    }

    fn handle(&self) -> DataServiceHandle {
        DataServiceHandle::new(self.root.clone())
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn install(&self) {
        let data = self.root.join("ArknightsGameData");
        let excel = data.join("zh_CN/gamedata/excel");
        Self::write(&excel.join("story_review_table.json"), REVIEW_TABLE_JSON);
        Self::write(&excel.join("story_table.json"), STORY_TABLE_JSON);
        Self::write(&excel.join("story_review_meta_table.json"), REVIEW_META_JSON);
        Self::write(
            &data.join("version.json"),
            r#"{"commit":"fixture","fetched_at":1700000000}"#,
        );

        let story = data.join("zh_CN/gamedata/story");
        for (rel, body) in FIXTURE_SCRIPTS {
            Self::write(&story.join(format!("{}.txt", rel)), body);
        }
    }
}

/// Six scripts, deliberately loaded with演出指令 so the recall assertions double
/// as a guard on the parser: anything that leaks a `bg_` / `fx_` / `avg_` token
/// into the rendered text immediately becomes searchable and trips
/// `fixture_stage_directions_are_not_searchable`.
const FIXTURE_SCRIPTS: &[(&str, &str)] = &[
    (
        "obt/main/level_main_00-01",
        concat!(
            "[HEADER(key=\"title\", is_skippable=true)] 序章\n",
            "[Background(image=\"bg_rhodes_office\", screenadapt=\"coverall\")]\n",
            "[Effect(name=\"fx_snow\", x=0.5)]\n",
            "[PlayMusic(intro=\"$office_intro\", key=\"$office_loop\")]\n",
            "[name=\"凯尔希\"]博士，你终于醒了。\n",
            "[Character(name=\"char_002_amiya_1#4\")]\n",
            "[Dialog]博士！\n",
            "[Delay(time=1)]\n",
        ),
    ),
    (
        "obt/main/level_main_00-02",
        concat!(
            "[name=\"阿米娅\"]我们出发吧，罗德岛还有很多事要做。\n",
            "[Decision(options=\"立刻出发;再等等\", values=\"1;2\")]\n",
        ),
    ),
    (
        "activities/act1/act1_st01",
        concat!(
            "[Image(image=\"avg_1\")]\n",
            "[name=\"德克萨斯\"]雪很大。\n",
            "[name=\"{@nickname}\"]我知道了。\n",
            "[Subtitle(text=\"切城，深夜\", alignment=\"center\")]\n",
            "[Announce(text=\"紧急广播：全体撤离\", delay=1)]\n",
        ),
    ),
    (
        "obt/memory/char_002_amiya/char_002_amiya_1",
        "回忆的片段，模糊不清。\n",
    ),
    (
        "obt/roguelike/ro2/ro2_1",
        "[name=\"凯尔希\"]又见面了，博士。\n",
    ),
    (
        "obt/roguelike/ro2/ro2_2",
        "[name=\"缄默\"]回廊深处还有别的东西。\n",
    ),
];

const REVIEW_TABLE_JSON: &str = r#"{
  "main_0": {
    "id": "main_0",
    "name": "黑暗时代",
    "entryType": "MAINLINE",
    "actType": "NONE",
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

/// One fixture query and the exact set of stories it must return.
struct FixtureCase<'a> {
    query: &'a str,
    /// Every `story_id` the query must return — no more, no less.
    expected: &'a [&'a str],
    why: &'a str,
}

const FIXTURE_CASES: &[FixtureCase<'static>] = &[
    FixtureCase {
        query: "凯尔希",
        expected: &["Obt/Roguelike/ro2/ro2_1", "main_00-01"],
        why: "说话人名进正文；肉鸽脚本和主线都要命中",
    },
    FixtureCase {
        query: "博士",
        expected: &["Obt/Roguelike/ro2/ro2_1", "act1_st01", "main_00-01"],
        why: "{@nickname} 必须在解析阶段就换成「博士」，说话人位置也算",
    },
    FixtureCase {
        query: "-凯尔希 博士",
        expected: &["act1_st01"],
        why: "NOT 排除掉两篇含凯尔希的，只剩活动篇",
    },
    FixtureCase {
        query: "凯尔希 or 德克萨斯",
        expected: &["Obt/Roguelike/ro2/ro2_1", "act1_st01", "main_00-01"],
        why: "OR 是并集，不是交集",
    },
    FixtureCase {
        query: "\"罗德岛\"",
        expected: &["main_00-02"],
        why: "引号短语要求三个字连续出现",
    },
    FixtureCase {
        query: "立刻出发",
        expected: &["main_00-02"],
        why: "[Decision] 选项也要能被搜到",
    },
    FixtureCase {
        query: "切城",
        expected: &["act1_st01"],
        why: "[Subtitle] 的 text 属性要进正文",
    },
    FixtureCase {
        query: "紧急广播",
        expected: &["act1_st01"],
        why: "解析器不认识的指令若把正文放在 text= 里，也不能整句丢掉",
    },
    FixtureCase {
        query: "序章",
        expected: &["main_00-01"],
        why: "标题命中",
    },
    FixtureCase {
        query: "0-1",
        expected: &["main_00-01"],
        why: "storyCode 命中；连字符不能被当成 NOT",
    },
    FixtureCase {
        query: "回廊",
        expected: &["Obt/Roguelike/ro2/ro2_2"],
        why: "肉鸽脚本走 story_table，漏了它整个肉鸽都搜不到",
    },
    FixtureCase {
        query: "模糊不清",
        expected: &["memory_amiya_1"],
        why: "没有任何指令的纯旁白行",
    },
    FixtureCase {
        query: "阿米娅",
        expected: &["main_00-02"],
        why: "中文显示名只在写了 [name=\"阿米娅\"] 的那篇里",
    },
    FixtureCase {
        query: "abcdxyz",
        expected: &[],
        why: "无意义 ASCII",
    },
    FixtureCase {
        query: "()",
        expected: &[],
        why: "纯标点不能报错，也不能命中",
    },
];

fn story_ids(page: &story_teller_lib::data_service_test::SearchResultsPage) -> Vec<String> {
    let mut ids: Vec<String> = page.results.iter().map(|r| r.story_id.clone()).collect();
    ids.sort();
    ids
}

#[test]
fn fixture_story_level_recall_is_exact() {
    let fx = Fixture::new("recall");
    let svc = fx.handle();

    let mut failures: Vec<String> = Vec::new();
    for case in FIXTURE_CASES {
        let page = match svc.search_stories_ex(case.query) {
            Ok(page) => page,
            Err(err) => {
                failures.push(format!("{:?} errored: {} ({})", case.query, err, case.why));
                continue;
            }
        };
        let got = story_ids(&page);
        let mut want: Vec<String> = case.expected.iter().map(|s| s.to_string()).collect();
        want.sort();
        if got != want {
            failures.push(format!(
                "{:?}: expected {:?}, got {:?} ({})",
                case.query, want, got, case.why
            ));
            continue;
        }
        if page.total_matched != want.len() {
            failures.push(format!(
                "{:?}: totalMatched {} != {} results ({})",
                case.query,
                page.total_matched,
                want.len(),
                case.why
            ));
        }
        if page.truncated {
            failures.push(format!("{:?}: unexpectedly truncated", case.query));
        }
    }

    assert!(
        failures.is_empty(),
        "fixture recall regressions:\n  {}",
        failures.join("\n  ")
    );
}

/// 演出指令里的素材名（背景、特效、BGM、插画 token）不是正文。一旦解析器把
/// 它们漏进段落，用户就会在阅读器里看到 `fx_snow`，而且搜索也会命中它们 ——
/// 后者正是这里在盯的。
#[test]
fn fixture_stage_directions_are_not_searchable() {
    let fx = Fixture::new("stage");
    let svc = fx.handle();

    for token in [
        "bg_rhodes_office",
        "fx_snow",
        "office_loop",
        "avg_1",
        "coverall",
        "screenadapt",
        "is_skippable",
    ] {
        let page = svc
            .search_stories_ex(token)
            .unwrap_or_else(|e| panic!("{:?} errored: {}", token, e));
        assert!(
            page.results.is_empty(),
            "{:?} leaked into the searchable text: {:?}",
            token,
            page.results
                .iter()
                .map(|r| (&r.story_id, &r.matched_text))
                .collect::<Vec<_>>()
        );
    }
}

/// 命中片段永远不能是空串——空预览在结果列表里就是一行看不懂的白条。
#[test]
fn fixture_previews_are_never_empty() {
    let fx = Fixture::new("preview");
    let svc = fx.handle();

    for case in FIXTURE_CASES.iter().filter(|c| !c.expected.is_empty()) {
        let page = svc.search_stories_ex(case.query).expect("search ok");
        for result in &page.results {
            assert!(
                !result.matched_text.trim().is_empty(),
                "empty preview for {:?} in {}",
                case.query,
                result.story_id
            );
            assert!(
                !result.story_name.trim().is_empty(),
                "empty story name for {:?}",
                case.query
            );
        }
    }
}

/// Facet 键必须是五个顶层桶之一；按完整分类名聚合会变成一章一个 chip。
#[test]
fn fixture_facets_are_top_level_buckets() {
    let fx = Fixture::new("facet");
    let svc = fx.handle();

    let page = svc.search_stories_ex("博士").expect("search ok");
    let keys: Vec<&str> = page.facets.keys().map(String::as_str).collect();
    assert_eq!(keys, vec!["主线", "活动", "肉鸽"], "facets: {:?}", page.facets);
    assert_eq!(page.facets.values().sum::<usize>(), page.results.len());

    // 分类标签本身仍带具体章节名，桶是从它的前缀切出来的。
    let labels: Vec<&str> = page.results.iter().map(|r| r.category.as_str()).collect();
    assert!(
        labels.iter().any(|l| l.starts_with("主线 | ")),
        "expected a `主线 | <章节>` label, got {:?}",
        labels
    );
}

/// 肉鸽剧情登记在 `story_table.json` 而不是 review 表里，最容易整批掉队。
/// 列出来的每一篇都必须能通过阅读器用的同一条 `get_story_entry` 解析。
#[test]
fn fixture_roguelike_stories_are_reachable() {
    let fx = Fixture::new("rogue");
    let svc = fx.handle();

    let groups = svc.roguelike_group_names().expect("roguelike listing ok");
    assert_eq!(groups, vec!["RO2".to_string()]);

    let page = svc.search_stories_ex("回廊").expect("search ok");
    let rogue: Vec<&str> = page
        .results
        .iter()
        .map(|r| r.story_id.as_str())
        .filter(|id| id.to_ascii_lowercase().starts_with("obt/roguelike/"))
        .collect();
    assert_eq!(rogue, vec!["Obt/Roguelike/ro2/ro2_2"]);

    let (name, txt) = svc
        .story_entry("Obt/Roguelike/ro2/ro2_2")
        .expect("roguelike entry must resolve");
    assert_eq!(name, "孤钻·贰");
    assert_eq!(txt, "obt/roguelike/ro2/ro2_2");
}

/// 索引没建好时段落检索返回空页而不是报错——前端据此回退到篇级结果。
#[test]
fn fixture_segment_search_without_index_is_empty() {
    let fx = Fixture::new("noindex");
    let svc = fx.handle();

    // 同一个词在篇级是有结果的，所以这里的空页只可能来自「索引未建立」。
    assert!(!svc.search_stories_ex("凯尔希").unwrap().results.is_empty());

    let page = svc
        .search_segments("凯尔希")
        .expect("segment search must not error without an index");
    assert!(page.hits.is_empty());
    assert_eq!(page.total_matched, 0);
    assert!(!page.truncated);
}

/// FTS 查询构造器不能因为任何输入炸掉。装了数据集才有意义：没有数据集时
/// 篇级检索在读表那一步就返回 `NOT_INSTALLED`，根本走不到查询构造。
#[test]
fn fixture_adversarial_queries_are_safe() {
    let fx = Fixture::new("adversarial");
    let svc = fx.handle();

    for q in ADVERSARIAL_QUERIES {
        if let Err(e) = svc.search_stories_ex(q) {
            panic!("adversarial story query {:?} errored: {}", q, e);
        }
        if let Err(e) = svc.search_segments(q) {
            panic!("adversarial segment query {:?} errored: {}", q, e);
        }
    }
}

/// Struct describing one test query and its expectations.
struct Case<'a> {
    /// Free-text query the user would type.
    query: &'a str,
    /// Minimum number of story-level hits we expect. Higher is stricter.
    min_story_hits: usize,
    /// Minimum number of segment-level hits we expect.
    min_segment_hits: usize,
    /// Optional story_id that MUST appear in the top 30 story results.
    expected_story_id: Option<&'a str>,
    /// Optional notes explaining intent (printed on failure).
    note: &'a str,
}

/// 30 real-world queries covering:
/// - single CJK word (short / long)
/// - multi-word AND
/// - explicit OR
/// - NOT (exclusion)
/// - ASCII term with prefix
/// - mixed CJK + digit
/// - quoted phrase
/// - punctuation-heavy
/// - typo-tolerance cases (currently expected to *not* match — used to track regressions)
/// - story_code lookup
/// - character nicknames
/// - corner cases (empty-ish, pure punctuation)
///
/// Note: CJK is tokenized one character at a time (no jieba / user dictionary
/// any more), so a multi-char name is an AND over its characters rather than a
/// single dictionary word. Expectations below are stated in those terms.
const QUERIES: &[Case<'static>] = &[
    Case { query: "凯尔希", min_story_hits: 100, min_segment_hits: 500, expected_story_id: None, note: "core operator name, very common" },
    Case { query: "阿米娅", min_story_hits: 100, min_segment_hits: 500, expected_story_id: None, note: "primary protagonist" },
    Case { query: "博士", min_story_hits: 200, min_segment_hits: 1500, expected_story_id: None, note: "{@nickname} replacement must be indexed as 博士" },
    Case { query: "罗德岛", min_story_hits: 150, min_segment_hits: 800, expected_story_id: None, note: "faction name" },
    Case { query: "整合运动", min_story_hits: 50, min_segment_hits: 200, expected_story_id: None, note: "antagonist faction" },
    Case { query: "源石", min_story_hits: 100, min_segment_hits: 400, expected_story_id: None, note: "lore term" },
    Case { query: "源石技艺", min_story_hits: 20, min_segment_hits: 80, expected_story_id: None, note: "compound lore term, matched as an AND over its characters" },
    Case { query: "感染者", min_story_hits: 50, min_segment_hits: 200, expected_story_id: None, note: "lore term" },
    Case { query: "PRTS", min_story_hits: 30, min_segment_hits: 150, expected_story_id: None, note: "ASCII acronym with prefix matching" },
    Case { query: "prts", min_story_hits: 30, min_segment_hits: 150, expected_story_id: None, note: "ASCII is case-insensitive" },
    Case { query: "凯尔希 阿米娅", min_story_hits: 30, min_segment_hits: 50, expected_story_id: None, note: "AND over two operator names" },
    Case { query: "凯尔希阿米娅", min_story_hits: 30, min_segment_hits: 50, expected_story_id: None, note: "no whitespace — char-level AND still recovers both names" },
    Case { query: "阿米娅 or 凯尔希", min_story_hits: 200, min_segment_hits: 800, expected_story_id: None, note: "OR union must match each name" },
    Case { query: "-凯尔希 博士", min_story_hits: 50, min_segment_hits: 300, expected_story_id: None, note: "NOT exclusion with implicit AND on second term" },
    Case { query: "\"凯尔希\"", min_story_hits: 100, min_segment_hits: 500, expected_story_id: None, note: "quoted phrase = exact name" },
    Case { query: "德克萨斯", min_story_hits: 30, min_segment_hits: 100, expected_story_id: None, note: "operator name" },
    Case { query: "能天使", min_story_hits: 20, min_segment_hits: 60, expected_story_id: None, note: "operator name" },
    Case { query: "特蕾西娅", min_story_hits: 10, min_segment_hits: 30, expected_story_id: None, note: "4-char operator name" },
    Case { query: "Rhodes Island", min_story_hits: 0, min_segment_hits: 0, expected_story_id: None, note: "Latin name — may not be common, but must not crash" },
    Case { query: "你好吗", min_story_hits: 5, min_segment_hits: 10, expected_story_id: None, note: "short common phrase" },
    Case { query: "大地惊雷", min_story_hits: 1, min_segment_hits: 1, expected_story_id: Some("1stact_level_a001_ex01_end"), note: "exact story name lookup must rank first" },
    Case { query: "西部往事", min_story_hits: 1, min_segment_hits: 1, expected_story_id: Some("1stact_level_a001_ex06_end"), note: "exact story name lookup" },
    Case { query: "真理", min_story_hits: 30, min_segment_hits: 80, expected_story_id: None, note: "single common word" },
    Case { query: "()", min_story_hits: 0, min_segment_hits: 0, expected_story_id: None, note: "pure punctuation → no results, must not error" },
    Case { query: "***", min_story_hits: 0, min_segment_hits: 0, expected_story_id: None, note: "pure FTS specials → no results, must not error" },
    Case { query: "阿", min_story_hits: 100, min_segment_hits: 500, expected_story_id: None, note: "single CJK char fallback must still match via per-char tokens" },
    Case { query: "希", min_story_hits: 100, min_segment_hits: 500, expected_story_id: None, note: "single CJK char" },
    Case { query: "莱茵生命", min_story_hits: 20, min_segment_hits: 60, expected_story_id: None, note: "org name" },
    Case { query: "炎国", min_story_hits: 5, min_segment_hits: 10, expected_story_id: None, note: "two-char faction name" },
    Case { query: "abcdxyz", min_story_hits: 0, min_segment_hits: 0, expected_story_id: None, note: "nonsense ASCII — no matches" },
];

#[test]
#[ignore = "requires synced dataset; run with --ignored"]
fn story_level_recall_survey() {
    let svc = setup();

    let mut failures: Vec<String> = Vec::new();
    let mut summary: Vec<(String, usize, bool)> = Vec::new();
    for case in QUERIES {
        let page = svc
            .search_stories_ex(case.query)
            .expect("search_stories_ex must not error");
        let total = page.total_matched;
        let top_ids: Vec<&str> = page.results.iter().take(30).map(|r| r.story_id.as_str()).collect();

        let mut ok = true;
        if total < case.min_story_hits {
            ok = false;
            failures.push(format!(
                "[story] {:?}: expected ≥{} hits, got {} (note: {})",
                case.query, case.min_story_hits, total, case.note
            ));
        }
        // 结果页最多 SEARCH_RESULT_LIMIT 条，`total_matched` 是截断前的总数，
        // 所以前者永远不该超过后者。
        if page.results.len() > total {
            ok = false;
            failures.push(format!(
                "[story] {:?}: returned {} results but reported only {} matches",
                case.query,
                page.results.len(),
                total
            ));
        }
        if page.truncated != (total > page.results.len()) {
            ok = false;
            failures.push(format!(
                "[story] {:?}: truncated={} but {} of {} results returned",
                case.query,
                page.truncated,
                page.results.len(),
                total
            ));
        }
        for result in &page.results {
            if result.matched_text.trim().is_empty() {
                ok = false;
                failures.push(format!(
                    "[story] {:?}: empty preview for {}",
                    case.query, result.story_id
                ));
                break;
            }
        }
        if let Some(expected) = case.expected_story_id {
            if !top_ids.iter().any(|id| *id == expected) {
                ok = false;
                failures.push(format!(
                    "[story] {:?}: expected story {:?} in top 30, got {:?} (note: {})",
                    case.query,
                    expected,
                    top_ids.into_iter().take(5).collect::<Vec<_>>(),
                    case.note
                ));
            }
        }
        summary.push((case.query.to_string(), total, ok));
    }

    eprintln!("\n=== Story-level recall summary ===");
    for (q, hits, ok) in &summary {
        eprintln!("  {} {:<20} → {} hits", if *ok { "✓" } else { "✗" }, q, hits);
    }
    if !failures.is_empty() {
        panic!("\nStory-level recall regressions:\n  {}", failures.join("\n  "));
    }
}

#[test]
#[ignore = "requires synced dataset + segment index; run with --ignored"]
fn segment_level_recall_survey() {
    let svc = setup();

    let mut failures: Vec<String> = Vec::new();
    let mut summary: Vec<(String, usize, bool)> = Vec::new();
    for case in QUERIES {
        let page = svc
            .search_segments(case.query)
            .expect("search_segments must not error");
        let total = page.total_matched;

        let mut ok = true;
        if total < case.min_segment_hits {
            ok = false;
            failures.push(format!(
                "[seg] {:?}: expected ≥{} hits, got {} (note: {})",
                case.query, case.min_segment_hits, total, case.note
            ));
        }
        for hit in &page.hits {
            // `matchTarget` 决定前端要不要打「按说话人命中」的角标；只有这
            // 两个取值，多出来的会让角标逻辑静默失效。
            if hit.match_target != "body" && hit.match_target != "speaker" {
                ok = false;
                failures.push(format!(
                    "[seg] {:?}: unknown matchTarget {:?} on {}#{}",
                    case.query, hit.match_target, hit.story_id, hit.segment_index
                ));
                break;
            }
            if hit.matched_text.trim().is_empty() {
                ok = false;
                failures.push(format!(
                    "[seg] {:?}: empty snippet on {}#{}",
                    case.query, hit.story_id, hit.segment_index
                ));
                break;
            }
        }
        summary.push((case.query.to_string(), total, ok));
    }

    eprintln!("\n=== Segment-level recall summary ===");
    for (q, hits, ok) in &summary {
        eprintln!("  {} {:<20} → {} hits", if *ok { "✓" } else { "✗" }, q, hits);
    }
    if !failures.is_empty() {
        panic!("\nSegment-level recall regressions:\n  {}", failures.join("\n  "));
    }
}

/// Facet bucketing: the backend must collapse per-chapter categories into
/// the five top-level types. A real query should produce a handful of
/// facets, not one per chapter.
#[test]
#[ignore = "requires index; run with --ignored"]
fn facets_are_top_level_buckets() {
    let svc = setup();
    let page = svc.search_stories_ex("凯尔希").expect("search ok");

    // The raw categories on results do contain ` | `-suffixed specifics,
    // but the facet keys must be the bare prefix so the chip row doesn't
    // blow up.
    let allowed: std::collections::HashSet<&str> = [
        "主线", "活动", "支线", "肉鸽", "干员密录",
    ]
    .into_iter()
    .collect();

    eprintln!("facets for '凯尔希': {:?}", page.facets);
    assert!(
        !page.facets.is_empty(),
        "expected at least one facet bucket"
    );
    assert!(
        page.facets.len() <= allowed.len(),
        "too many facets ({}) — categories not being bucketed: {:?}",
        page.facets.len(),
        page.facets
    );
    for k in page.facets.keys() {
        assert!(
            allowed.contains(k.as_str()),
            "unexpected facet key {:?} — must be one of {:?}",
            k,
            allowed
        );
    }
}

/// Inputs that have historically produced malformed FTS5 queries: unbalanced
/// quotes and parens, bare operators, lone hyphens, FTS specials and
/// full-width punctuation. Shared by the fixture tier and the real-corpus
/// tier so both exercise the same pool.
const ADVERSARIAL_QUERIES: &[&str] = &[
    "",
    " ",
    "  ",
    "\t\n",
    "(",
    ")",
    "(())",
    "\"",
    "\"\"",
    "\"凯尔希",
    "\"凯尔希 阿米娅",
    ":",
    "^",
    "NEAR",
    "AND",
    "OR",
    "NOT",
    "and",
    "or",
    "not",
    "or or or",
    "*",
    "**",
    "-",
    "--",
    "-凯尔希",
    "-\"凯尔希\"",
    "凯尔希 -",
    "凯尔希 - 博士",
    "a AND b AND c AND d",
    "a OR b OR c OR d",
    "a+b+c",
    "a+b AND c",
    "凯尔希*阿米娅",
    "凯/尔/希",
    "凯(尔)希",
    "\"凯\"\"尔\"\"希\"",
    "凯尔希 博士 阿米娅 能天使 德克萨斯",
    "Rhodes Island & Arknights",
    "\u{FF5E}\u{3002}\u{FF0C}",
    "FULL_WIDTH：ＡＢＣ",
    "\u{1F600}",
    "アイ",
    "{@nickname}",
];

/// Smoke test: verify the FTS query builder never produces syntax errors
/// for a broad pool of adversarial inputs. Runs a real SQLite prepare to
/// catch malformed queries.
#[test]
#[ignore = "requires index; run with --ignored"]
fn adversarial_query_safety() {
    let svc = setup();

    for q in ADVERSARIAL_QUERIES {
        match svc.search_stories_ex(q) {
            Ok(_) => {}
            Err(e) => panic!("adversarial query {:?} errored: {}", q, e),
        }
        match svc.search_segments(q) {
            Ok(_) => {}
            Err(e) => panic!("adversarial segment query {:?} errored: {}", q, e),
        }
    }
}

/// Roguelike scripts live in `story_table.json`, not in the review table, so
/// they are easy to drop on the floor. With a real dataset every roguelike
/// group must be listed and every listed story must resolve through the same
/// `get_story_entry` path the reader uses.
#[test]
#[ignore = "requires synced dataset; run with --ignored"]
fn roguelike_stories_are_reachable() {
    let svc = setup();

    let groups = svc
        .roguelike_group_names()
        .expect("roguelike listing must not error");
    assert!(!groups.is_empty(), "expected at least one roguelike theme");
    eprintln!("roguelike groups: {:?}", groups);

    // Story ids are the raw `Obt/Roguelike/...` table keys.
    let page = svc.search_stories_ex("回廊").expect("search ok");
    let rogue: Vec<&str> = page
        .results
        .iter()
        .take(50)
        .map(|r| r.story_id.as_str())
        .filter(|id| id.to_ascii_lowercase().starts_with("obt/roguelike/"))
        .collect();
    // 以前这里找不到肉鸽结果就直接走完循环，测试照样绿——等于什么都没测。
    assert!(
        !rogue.is_empty(),
        "「回廊」的前 50 条里一篇肉鸽都没有，肉鸽剧情很可能整批没进索引"
    );
    for story_id in rogue {
        svc.story_entry(story_id)
            .unwrap_or_else(|e| panic!("roguelike {} unreachable: {}", story_id, e));
    }
}

/// Without a dataset the search commands must degrade predictably instead of
/// panicking: story search reports `NOT_INSTALLED`, and segment search — which
/// only ever consults the index — returns an empty page.
#[test]
fn missing_dataset_degrades_gracefully() {
    let root = std::env::temp_dir().join(format!(
        "ark_recall_empty_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let svc = DataServiceHandle::new(root.clone());

    let err = svc
        .search_stories_ex("凯尔希")
        .expect_err("story search needs a dataset");
    assert_eq!(err, "NOT_INSTALLED");

    let page = svc
        .search_segments("凯尔希")
        .expect("segment search must not error without a dataset");
    assert!(page.hits.is_empty());
    assert_eq!(page.total_matched, 0);

    assert!(svc.story_entry("main_00-01").is_err());
    assert!(svc.roguelike_group_names().is_err());

    // 病态查询在「没装数据集」这条分支上也不能变成 panic 或别的错误码。
    for q in ADVERSARIAL_QUERIES {
        match svc.search_stories_ex(q) {
            Ok(page) => assert!(
                page.results.is_empty(),
                "{:?} returned results without a dataset",
                q
            ),
            Err(err) => assert_eq!(err, "NOT_INSTALLED", "unexpected error for {:?}", q),
        }
        let page = svc
            .search_segments(q)
            .unwrap_or_else(|e| panic!("segment query {:?} errored: {}", q, e));
        assert!(page.hits.is_empty());
    }

    let _ = std::fs::remove_dir_all(&root);
}

/// Timing regression guard: each query should return within a soft budget.
/// The budget is loose because these tests run in debug mode; primarily we
/// want to catch accidental O(N*M) regressions (e.g. unbounded fallback scan
/// on every call).
#[test]
#[ignore = "requires index; run with --ignored"]
fn latency_budget() {
    let svc = setup();

    let budget = std::time::Duration::from_millis(4_000);
    let mut worst = std::time::Duration::ZERO;
    let mut failures: Vec<String> = Vec::new();
    for case in QUERIES {
        let t0 = std::time::Instant::now();
        // 之前这里丢掉了返回值：查询报错时耗时接近 0，反而「通过」了预算。
        svc.search_stories_ex(case.query)
            .unwrap_or_else(|e| panic!("{:?} errored: {}", case.query, e));
        let elapsed = t0.elapsed();
        worst = worst.max(elapsed);
        if elapsed > budget {
            failures.push(format!(
                "[latency] {:?}: took {:?} (> {:?})",
                case.query, elapsed, budget
            ));
        }
    }
    eprintln!("worst-case story_ex latency: {:?}", worst);
    if !failures.is_empty() {
        panic!(
            "Search latency regressions:\n  {}",
            failures.join("\n  ")
        );
    }
}
