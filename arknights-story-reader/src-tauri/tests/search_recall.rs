//! End-to-end search recall tests.
//!
//! These run against a real ArknightsGameData checkout + story_index.db. They
//! require the app to have been launched at least once (or manually populated)
//! so that the dataset and index exist under the OS-specific app-data dir.
//!
//! The tests are `#[ignore]` by default — run with:
//!
//!     cargo test --test search_recall -- --ignored --nocapture --test-threads=1
//!
//! Purpose: guarantee that changes to the tokenizer / query builder do not
//! silently regress common real-world queries. Each query declares a lower
//! bound on the expected hit count (minimum) and, where useful, a sample
//! story whose `story_id` must appear in the top-N.

use std::path::PathBuf;

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

fn setup() -> Option<DataServiceHandle> {
    let root = app_data_root()?;
    if !root.join("ArknightsGameData").exists() || !root.join("story_index.db").exists() {
        eprintln!(
            "skip: dataset or index missing at {:?} (run the app once to sync, or set ARKNIGHTS_READER_DATA_ROOT)",
            root
        );
        return None;
    }
    Some(DataServiceHandle::new(root))
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
const QUERIES: &[Case<'static>] = &[
    Case { query: "凯尔希", min_story_hits: 100, min_segment_hits: 500, expected_story_id: None, note: "core operator name, very common" },
    Case { query: "阿米娅", min_story_hits: 100, min_segment_hits: 500, expected_story_id: None, note: "primary protagonist" },
    Case { query: "博士", min_story_hits: 200, min_segment_hits: 1500, expected_story_id: None, note: "{@nickname} replacement must be indexed as 博士" },
    Case { query: "罗德岛", min_story_hits: 150, min_segment_hits: 800, expected_story_id: None, note: "faction name" },
    Case { query: "整合运动", min_story_hits: 50, min_segment_hits: 200, expected_story_id: None, note: "antagonist faction" },
    Case { query: "源石", min_story_hits: 100, min_segment_hits: 400, expected_story_id: None, note: "lore term" },
    Case { query: "源石技艺", min_story_hits: 20, min_segment_hits: 80, expected_story_id: None, note: "compound lore term must be recognized whole" },
    Case { query: "感染者", min_story_hits: 50, min_segment_hits: 200, expected_story_id: None, note: "lore term" },
    Case { query: "PRTS", min_story_hits: 30, min_segment_hits: 150, expected_story_id: None, note: "ASCII acronym with prefix matching" },
    Case { query: "prts", min_story_hits: 30, min_segment_hits: 150, expected_story_id: None, note: "ASCII is case-insensitive" },
    Case { query: "凯尔希 阿米娅", min_story_hits: 30, min_segment_hits: 50, expected_story_id: None, note: "AND over two operator names" },
    Case { query: "凯尔希阿米娅", min_story_hits: 30, min_segment_hits: 50, expected_story_id: None, note: "must jieba-split to two names" },
    Case { query: "阿米娅 or 凯尔希", min_story_hits: 200, min_segment_hits: 800, expected_story_id: None, note: "OR union must match each name" },
    Case { query: "-凯尔希 博士", min_story_hits: 50, min_segment_hits: 300, expected_story_id: None, note: "NOT exclusion with implicit AND on second term" },
    Case { query: "\"凯尔希\"", min_story_hits: 100, min_segment_hits: 500, expected_story_id: None, note: "quoted phrase = exact name" },
    Case { query: "德克萨斯", min_story_hits: 30, min_segment_hits: 100, expected_story_id: None, note: "user-dict operator" },
    Case { query: "能天使", min_story_hits: 20, min_segment_hits: 60, expected_story_id: None, note: "user-dict operator" },
    Case { query: "特蕾西娅", min_story_hits: 10, min_segment_hits: 30, expected_story_id: None, note: "4-char user-dict name" },
    Case { query: "Rhodes Island", min_story_hits: 0, min_segment_hits: 0, expected_story_id: None, note: "Latin name — may not be common, but must not crash" },
    Case { query: "你好吗", min_story_hits: 5, min_segment_hits: 10, expected_story_id: None, note: "short common phrase" },
    Case { query: "大地惊雷", min_story_hits: 1, min_segment_hits: 1, expected_story_id: Some("1stact_level_a001_ex01_end"), note: "exact story name lookup must rank first" },
    Case { query: "西部往事", min_story_hits: 1, min_segment_hits: 1, expected_story_id: Some("1stact_level_a001_ex06_end"), note: "exact story name lookup" },
    Case { query: "真理", min_story_hits: 30, min_segment_hits: 80, expected_story_id: None, note: "single common word" },
    Case { query: "()", min_story_hits: 0, min_segment_hits: 0, expected_story_id: None, note: "pure punctuation → no results, must not error" },
    Case { query: "***", min_story_hits: 0, min_segment_hits: 0, expected_story_id: None, note: "pure FTS specials → no results, must not error" },
    Case { query: "阿", min_story_hits: 100, min_segment_hits: 500, expected_story_id: None, note: "single CJK char fallback must still match via per-char tokens" },
    Case { query: "希", min_story_hits: 100, min_segment_hits: 500, expected_story_id: None, note: "single CJK char" },
    Case { query: "莱茵生命", min_story_hits: 20, min_segment_hits: 60, expected_story_id: None, note: "user-dict org name" },
    Case { query: "炎国", min_story_hits: 5, min_segment_hits: 10, expected_story_id: None, note: "two-char faction name" },
    Case { query: "abcdxyz", min_story_hits: 0, min_segment_hits: 0, expected_story_id: None, note: "nonsense ASCII — no matches" },
];

#[test]
#[ignore = "requires synced dataset; run with --ignored"]
fn story_level_recall_survey() {
    let Some(svc) = setup() else { return };

    let mut failures: Vec<String> = Vec::new();
    let mut summary: Vec<(String, usize, bool)> = Vec::new();
    for case in QUERIES {
        let page = svc
            .search_stories_ex(case.query)
            .expect("search_stories_ex must not error");
        let hit_count = page.results.len();
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
        summary.push((case.query.to_string(), hit_count, ok));
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
    let Some(svc) = setup() else { return };

    let mut failures: Vec<String> = Vec::new();
    let mut summary: Vec<(String, usize, bool)> = Vec::new();
    for case in QUERIES {
        let page = svc
            .search_segments(case.query)
            .expect("search_segments must not error");
        let hit_count = page.hits.len();
        let total = page.total_matched;

        let mut ok = true;
        if total < case.min_segment_hits {
            ok = false;
            failures.push(format!(
                "[seg] {:?}: expected ≥{} hits, got {} (note: {})",
                case.query, case.min_segment_hits, total, case.note
            ));
        }
        summary.push((case.query.to_string(), hit_count, ok));
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
    let Some(svc) = setup() else { return };
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

/// Smoke test: verify the FTS query builder never produces syntax errors
/// for a broad pool of adversarial inputs. Runs a real SQLite prepare to
/// catch malformed queries.
#[test]
#[ignore = "requires index; run with --ignored"]
fn adversarial_query_safety() {
    let Some(svc) = setup() else { return };

    let adversarial: &[&str] = &[
        "",
        " ",
        "  ",
        "\t\n",
        "(",
        ")",
        "(())",
        "\"",
        "\"凯尔希",
        "\"凯尔希 阿米娅",
        "\"",
        ":",
        "AND",
        "OR",
        "NOT",
        "and",
        "or",
        "not",
        "*",
        "**",
        "-",
        "--",
        "-凯尔希",
        "-",
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
    ];
    for q in adversarial {
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

/// Timing regression guard: each query should return within a soft budget.
/// The budget is loose because these tests run in debug mode; primarily we
/// want to catch accidental O(N*M) regressions (e.g. unbounded fallback scan
/// on every call).
#[test]
#[ignore = "requires index; run with --ignored"]
fn latency_budget() {
    let Some(svc) = setup() else { return };

    let budget = std::time::Duration::from_millis(4_000);
    let worst: std::cell::Cell<std::time::Duration> = std::cell::Cell::new(std::time::Duration::ZERO);
    let mut failures: Vec<String> = Vec::new();
    for case in QUERIES {
        let t0 = std::time::Instant::now();
        let _ = svc.search_stories_ex(case.query);
        let elapsed = t0.elapsed();
        if elapsed > worst.get() {
            worst.set(elapsed);
        }
        if elapsed > budget {
            failures.push(format!(
                "[latency] {:?}: took {:?} (> {:?})",
                case.query, elapsed, budget
            ));
        }
    }
    eprintln!("worst-case story_ex latency: {:?}", worst.get());
    if !failures.is_empty() {
        panic!(
            "Search latency regressions:\n  {}",
            failures.join("\n  ")
        );
    }
}
