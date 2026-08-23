//! 干员名字 ↔ charId 映射。
//!
//! 编译时把 `assets/char_map.json` 嵌入 binary，避免首次启动前拿不到
//! character_table.json 时人物头像还是空的问题。运行时若 ArknightsGameData
//! 已经解压，还会做一次 overlay 以覆盖新干员。
//!
//! 加固要点：
//! - 解析全程宽容：单条记录坏了只跳过那一条，整份 JSON 坏了保留嵌入表；
//! - 任何路径都不 panic——读写锁毒化后就地恢复（索引只做插入，
//!   半途 panic 也不会破坏结构不变量）；
//! - overlay 以指纹（路径 + 大小 + mtime）去重，并忽略比已应用版本
//!   更旧的过期刷新，避免并发窗口里旧数据覆盖新数据。

use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{PoisonError, RwLock};

/// 静态嵌入的 `name → charId`（中文名、英文 appellation 均可作为 key）。
const EMBEDDED_MAP: &str = include_str!("../assets/char_map.json");

#[derive(Debug, Deserialize)]
struct EmbeddedPayload {
    #[serde(default)]
    ci2name: HashMap<String, String>,
    #[serde(default)]
    name2ci: HashMap<String, String>,
}

lazy_static! {
    static ref RUNTIME: RwLock<CharacterIndex> = RwLock::new(CharacterIndex::from_embedded());
    /// 已经 overlay 过的 `character_table.json` 指纹（路径 + 大小 + mtime）。
    /// 前端每次冷启动都会拉一次索引，而这张表有十几 MB，重复解析没有意义。
    static ref OVERLAID: RwLock<Option<TableFingerprint>> = RwLock::new(None);
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TableFingerprint {
    path: PathBuf,
    len: u64,
    /// mtime（UNIX 纳秒）；拿不到时为 -1，表示未知，不参与新旧比较。
    modified_nanos: i128,
}

fn fingerprint(path: &Path) -> Option<TableFingerprint> {
    let meta = std::fs::metadata(path).ok()?;
    Some(TableFingerprint {
        path: path.to_path_buf(),
        len: meta.len(),
        modified_nanos: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as i128)
            .unwrap_or(-1),
    })
}

/// 判断这次刷新是否应被忽略：
/// - 同一份文件已经处理过（指纹完全一致）；
/// - 或同一路径但 mtime 比已应用的版本更旧——并发/排队窗口里抓到的
///   过期快照，直接丢弃，防止旧表覆盖新表。
fn is_stale_refresh(applied: Option<&TableFingerprint>, incoming: &TableFingerprint) -> bool {
    match applied {
        None => false,
        Some(prev) if prev == incoming => true,
        Some(prev) => {
            prev.path == incoming.path
                && prev.modified_nanos >= 0
                && incoming.modified_nanos >= 0
                && incoming.modified_nanos < prev.modified_nanos
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CharacterIndex {
    /// charId → 中文名（UI 显示用）
    #[serde(rename = "charIdToName")]
    pub char_id_to_name: HashMap<String, String>,
    /// 中文名/别名 → charId（说话人指回）
    #[serde(rename = "nameToCharId")]
    pub name_to_char_id: HashMap<String, String>,
}

impl CharacterIndex {
    fn from_embedded() -> Self {
        match serde_json::from_str::<EmbeddedPayload>(EMBEDDED_MAP) {
            Ok(p) => Self {
                char_id_to_name: p.ci2name,
                name_to_char_id: p.name2ci,
            },
            Err(err) => {
                eprintln!("[char-table] failed to parse embedded map: {}", err);
                Self::default()
            }
        }
    }
}

/// character_table.json 中一条干员记录里我们关心的字段。
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedEntry {
    char_id: String,
    name: String,
    appellation: Option<String>,
}

/// 宽容地解析 character_table.json：
/// - 只认 `char_` 开头的 key，token/trap/NPC 概念不进索引
///   （剧情里的 NPC 头像由 asset_service 的覆盖表负责）；
/// - 单条记录不是对象、name 缺失/非字符串/空白，都跳过而不是整体失败；
/// - 整份 JSON 非法（或顶层不是对象）返回 `None`，与"合法但为空"区分开。
///
/// 结果按 charId 字典序排序，保证同名干员（精英化分形，如阿米娅的
/// 近卫/医疗形态）的 name → charId 映射不随 JSON 键序波动。
fn parse_character_table(raw: &str) -> Option<Vec<ParsedEntry>> {
    let json: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = json.as_object()?;
    let mut out = Vec::with_capacity(obj.len());
    for (cid, v) in obj {
        if !cid.starts_with("char_") {
            continue;
        }
        let Some(name) = v
            .get("name")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let appellation = v
            .get("appellation")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        out.push(ParsedEntry {
            char_id: cid.clone(),
            name: name.to_string(),
            appellation,
        });
    }
    out.sort_by(|a, b| a.char_id.cmp(&b.char_id));
    Some(out)
}

/// 把解析出来的记录 overlay 到索引上：
/// - charId → name 总是更新为最新（数据包给干员改名以新为准）；
/// - name/appellation → charId 只在尚无映射时插入（先到先得，保证嵌入表
///   与同名分形干员的既有映射稳定）。
fn apply_entries(index: &mut CharacterIndex, entries: &[ParsedEntry]) {
    for e in entries {
        index
            .char_id_to_name
            .insert(e.char_id.clone(), e.name.clone());
        index
            .name_to_char_id
            .entry(e.name.clone())
            .or_insert_with(|| e.char_id.clone());
        if let Some(alias) = &e.appellation {
            index
                .name_to_char_id
                .entry(alias.clone())
                .or_insert_with(|| e.char_id.clone());
        }
    }
}

/// 用运行时的 `character_table.json` 覆盖嵌入数据。静默失败，绝不 panic。
/// 同一份文件只 overlay 一次；数据包换了（大小或 mtime 变化）会重新读；
/// 比已应用版本更旧的过期刷新会被忽略。
pub fn refresh_from_file(path: &Path) {
    // 文件不存在/不可 stat：没有可刷新的内容，保持现状。
    let Some(current) = fingerprint(path) else {
        return;
    };

    // OVERLAID 写锁贯穿整个刷新：既让并发调用只解析一次这份十几 MB 的
    // JSON，也保证 stale 判断与指纹更新是原子的。锁毒化就地恢复——
    // 指纹只是缓存优化，最坏情况多解析一次。
    let mut overlaid = OVERLAID.write().unwrap_or_else(PoisonError::into_inner);
    if is_stale_refresh(overlaid.as_ref(), &current) {
        return;
    }

    // 读失败（权限、竞争删除等）视作瞬态错误：不记指纹，下次再试。
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };

    match parse_character_table(&raw) {
        Some(entries) if !entries.is_empty() => {
            let mut index = RUNTIME.write().unwrap_or_else(PoisonError::into_inner);
            apply_entries(&mut index, &entries);
        }
        Some(_) => {
            // 合法 JSON 但没有任何干员记录：保留嵌入表。
        }
        None => {
            eprintln!(
                "[char-table] {} is not a valid character table; keeping embedded map",
                path.display()
            );
        }
    }

    // 解析成败都记录指纹：同一份字节重复解析结果不会变，解析失败也没有
    // 必要每次冷启动重来一遍；文件内容一变（len/mtime 变化）自然会重试。
    *overlaid = Some(current);
}

/// 导出当前索引（给前端一次性拿走缓存，避免频繁查询）。
pub fn snapshot() -> CharacterIndex {
    RUNTIME
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// 按中文名/别名找 charId。名字带精英皮肤后缀（如 `阿米娅#2`）时会
/// 去掉 `#N` 再查一次。
pub fn name_to_id(name: &str) -> Option<String> {
    let n = name.trim();
    if n.is_empty() {
        return None;
    }
    let index = RUNTIME.read().unwrap_or_else(PoisonError::into_inner);
    if let Some(id) = index.name_to_char_id.get(n) {
        return Some(id.clone());
    }
    let base = n.split('#').next().map(str::trim).unwrap_or("");
    if base.is_empty() || base == n {
        return None;
    }
    index.name_to_char_id.get(base).cloned()
}

/// 按 charId 查中文显示名（用于 parser 回填 dialogue.character_name）。
/// 容忍带皮肤后缀的 charId（`char_002_amiya#2`）。
#[allow(dead_code)]
pub fn id_to_name(char_id: &str) -> Option<String> {
    let id = char_id.trim();
    if id.is_empty() {
        return None;
    }
    let index = RUNTIME.read().unwrap_or_else(PoisonError::into_inner);
    if let Some(name) = index.char_id_to_name.get(id) {
        return Some(name.clone());
    }
    let base = id.split('#').next().map(str::trim).unwrap_or("");
    if base.is_empty() || base == id {
        return None;
    }
    index.char_id_to_name.get(base).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(char_id: &str, name: &str, appellation: Option<&str>) -> ParsedEntry {
        ParsedEntry {
            char_id: char_id.to_string(),
            name: name.to_string(),
            appellation: appellation.map(str::to_string),
        }
    }

    // ---------- 嵌入数据 ----------

    #[test]
    fn embedded_map_parses_and_is_consistent() {
        let index = CharacterIndex::from_embedded();
        assert!(!index.char_id_to_name.is_empty());
        assert!(!index.name_to_char_id.is_empty());
        // 每个 name → charId 的目标都必须能反查显示名，否则头像能命中
        // 但 UI 名字为空。
        for (name, id) in &index.name_to_char_id {
            assert!(!name.trim().is_empty());
            assert!(
                index.char_id_to_name.contains_key(id),
                "name {name:?} maps to unknown charId {id:?}"
            );
        }
    }

    #[test]
    fn embedded_map_contains_known_operators() {
        let index = CharacterIndex::from_embedded();
        assert_eq!(
            index.char_id_to_name.get("char_285_medic2").map(String::as_str),
            Some("Lancet-2")
        );
        assert_eq!(
            index.name_to_char_id.get("夜刀").map(String::as_str),
            Some("char_502_nblade")
        );
        // 英文 appellation 也能作为 key。
        assert_eq!(
            index.name_to_char_id.get("Lancet-2").map(String::as_str),
            Some("char_285_medic2")
        );
    }

    // ---------- 解析加固 ----------

    #[test]
    fn parse_rejects_invalid_json_without_panicking() {
        assert_eq!(parse_character_table("{ not json"), None);
        assert_eq!(parse_character_table(""), None);
        // 合法 JSON 但顶层不是对象。
        assert_eq!(parse_character_table("[1, 2, 3]"), None);
        assert_eq!(parse_character_table("\"char_002_amiya\""), None);
        assert_eq!(parse_character_table("null"), None);
    }

    #[test]
    fn parse_skips_malformed_entries_but_keeps_good_ones() {
        let raw = r#"{
            "char_002_amiya": {"name": "阿米娅", "appellation": "Amiya"},
            "char_bad_scalar": 42,
            "char_bad_null": null,
            "char_bad_array": ["nope"],
            "char_no_name": {"appellation": "Ghost"},
            "char_null_name": {"name": null},
            "char_numeric_name": {"name": 7},
            "char_blank_name": {"name": "   "}
        }"#;
        let entries = parse_character_table(raw).expect("valid json");
        assert_eq!(
            entries,
            vec![entry("char_002_amiya", "阿米娅", Some("Amiya"))]
        );
    }

    #[test]
    fn parse_ignores_non_operator_keys() {
        // token/trap/NPC 概念不进索引；NPC 头像由 asset_service 的
        // NPC_AVATAR_OVERRIDES 覆盖表负责。
        let raw = r#"{
            "token_10000_silent_deer": {"name": "鹿角"},
            "trap_001_crate": {"name": "箱子"},
            "npc_005_priestess": {"name": "普瑞赛斯"},
            "char_502_nblade": {"name": "夜刀"}
        }"#;
        let entries = parse_character_table(raw).expect("valid json");
        assert_eq!(entries, vec![entry("char_502_nblade", "夜刀", None)]);
    }

    #[test]
    fn parse_trims_and_drops_blank_appellation() {
        let raw = r#"{
            "char_a": {"name": "  甲  ", "appellation": "  Alpha  "},
            "char_b": {"name": "乙", "appellation": "   "},
            "char_c": {"name": "丙", "appellation": null}
        }"#;
        let entries = parse_character_table(raw).expect("valid json");
        assert_eq!(
            entries,
            vec![
                entry("char_a", "甲", Some("Alpha")),
                entry("char_b", "乙", None),
                entry("char_c", "丙", None),
            ]
        );
    }

    #[test]
    fn parse_orders_entries_by_char_id() {
        let raw = r#"{
            "char_1037_amiya3": {"name": "阿米娅"},
            "char_002_amiya": {"name": "阿米娅"},
            "char_1001_amiya2": {"name": "阿米娅"}
        }"#;
        let entries = parse_character_table(raw).expect("valid json");
        let ids: Vec<&str> = entries.iter().map(|e| e.char_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["char_002_amiya", "char_1001_amiya2", "char_1037_amiya3"]
        );
    }

    // ---------- overlay 合并 ----------

    #[test]
    fn duplicate_names_map_to_first_char_id_deterministically() {
        // 精英化分形：阿米娅的近卫/医疗形态与本体共用中文名。名字必须
        // 稳定指回本体（charId 字典序最小），而每个形态都能反查显示名。
        let mut index = CharacterIndex::default();
        let entries = parse_character_table(
            r#"{
                "char_1037_amiya3": {"name": "阿米娅", "appellation": "Amiya"},
                "char_002_amiya": {"name": "阿米娅", "appellation": "Amiya"},
                "char_1001_amiya2": {"name": "阿米娅", "appellation": "Amiya"}
            }"#,
        )
        .expect("valid json");
        apply_entries(&mut index, &entries);

        assert_eq!(
            index.name_to_char_id.get("阿米娅").map(String::as_str),
            Some("char_002_amiya")
        );
        assert_eq!(
            index.name_to_char_id.get("Amiya").map(String::as_str),
            Some("char_002_amiya")
        );
        for id in ["char_002_amiya", "char_1001_amiya2", "char_1037_amiya3"] {
            assert_eq!(
                index.char_id_to_name.get(id).map(String::as_str),
                Some("阿米娅")
            );
        }
    }

    #[test]
    fn overlay_updates_display_name_but_keeps_existing_name_mapping() {
        // 数据包给干员改名：显示名以新为准，旧名字的反查映射不被抹掉
        // （旧存档/旧脚本仍然写着旧名）。
        let mut index = CharacterIndex::default();
        apply_entries(&mut index, &[entry("char_x", "旧名", None)]);
        apply_entries(&mut index, &[entry("char_x", "新名", None)]);

        assert_eq!(
            index.char_id_to_name.get("char_x").map(String::as_str),
            Some("新名")
        );
        assert_eq!(
            index.name_to_char_id.get("旧名").map(String::as_str),
            Some("char_x")
        );
        assert_eq!(
            index.name_to_char_id.get("新名").map(String::as_str),
            Some("char_x")
        );
    }

    #[test]
    fn overlay_never_steals_name_from_embedded_mapping() {
        // 嵌入表已有的 name → charId 不能被后来的同名条目改指向。
        let mut index = CharacterIndex::default();
        apply_entries(&mut index, &[entry("char_002_amiya", "阿米娅", None)]);
        apply_entries(&mut index, &[entry("char_9999_fake", "阿米娅", None)]);

        assert_eq!(
            index.name_to_char_id.get("阿米娅").map(String::as_str),
            Some("char_002_amiya")
        );
        // 新 charId 仍然可以反查显示名。
        assert_eq!(
            index.char_id_to_name.get("char_9999_fake").map(String::as_str),
            Some("阿米娅")
        );
    }

    // ---------- 过期刷新判定 ----------

    fn fp(path: &str, len: u64, mtime: i128) -> TableFingerprint {
        TableFingerprint {
            path: PathBuf::from(path),
            len,
            modified_nanos: mtime,
        }
    }

    #[test]
    fn stale_refresh_detection() {
        let applied = fp("/data/character_table.json", 100, 2_000);

        // 尚未 overlay 过：任何指纹都不算过期。
        assert!(!is_stale_refresh(None, &applied));
        // 完全相同的指纹：已处理过，跳过。
        assert!(is_stale_refresh(Some(&applied), &applied.clone()));
        // 同一路径、更旧的 mtime：过期快照，忽略。
        assert!(is_stale_refresh(
            Some(&applied),
            &fp("/data/character_table.json", 90, 1_000)
        ));
        // 同一路径、更新的 mtime：正常刷新。
        assert!(!is_stale_refresh(
            Some(&applied),
            &fp("/data/character_table.json", 110, 3_000)
        ));
        // 同一路径、mtime 相同但大小变了：内容变化，重新应用。
        assert!(!is_stale_refresh(
            Some(&applied),
            &fp("/data/character_table.json", 110, 2_000)
        ));
        // 路径不同（数据目录迁移）：不算过期。
        assert!(!is_stale_refresh(
            Some(&applied),
            &fp("/elsewhere/character_table.json", 90, 1_000)
        ));
        // mtime 未知（-1）：无法比较新旧，宁可重新应用。
        assert!(!is_stale_refresh(
            Some(&fp("/data/character_table.json", 100, -1)),
            &fp("/data/character_table.json", 90, 1_000)
        ));
        assert!(!is_stale_refresh(
            Some(&applied),
            &fp("/data/character_table.json", 90, -1)
        ));
    }

    // ---------- 查询 ----------

    #[test]
    fn name_lookup_trims_and_handles_skin_suffix() {
        assert_eq!(name_to_id("夜刀").as_deref(), Some("char_502_nblade"));
        assert_eq!(name_to_id("  夜刀  ").as_deref(), Some("char_502_nblade"));
        // 精英皮肤后缀 `#N` 去掉后再查。
        assert_eq!(name_to_id("夜刀#2").as_deref(), Some("char_502_nblade"));
        assert_eq!(name_to_id("夜刀#2#extra").as_deref(), Some("char_502_nblade"));
        assert_eq!(name_to_id(""), None);
        assert_eq!(name_to_id("   "), None);
        assert_eq!(name_to_id("#2"), None);
        assert_eq!(name_to_id("不存在的干员"), None);
    }

    #[test]
    fn npc_names_are_not_in_the_operator_index() {
        // NPC（普瑞赛斯/希尔达）不在 character_table 里，必须返回 None，
        // 让 asset_service 的 NPC 覆盖表接手，而不是错误命中某个干员。
        assert_eq!(name_to_id("普瑞赛斯"), None);
        assert_eq!(name_to_id("希尔达"), None);
    }

    #[test]
    fn id_lookup_handles_skin_suffix_and_garbage() {
        assert_eq!(id_to_name("char_285_medic2").as_deref(), Some("Lancet-2"));
        assert_eq!(id_to_name(" char_285_medic2 ").as_deref(), Some("Lancet-2"));
        assert_eq!(id_to_name("char_285_medic2#1").as_deref(), Some("Lancet-2"));
        assert_eq!(id_to_name(""), None);
        assert_eq!(id_to_name("#1"), None);
        assert_eq!(id_to_name("char_does_not_exist"), None);
    }

    // ---------- refresh_from_file 集成 ----------

    #[test]
    fn refresh_survives_missing_and_corrupt_files_then_overlays() {
        // 不存在的路径：不 panic，不动索引。
        refresh_from_file(Path::new("/definitely/not/here/character_table.json"));
        assert_eq!(name_to_id("夜刀").as_deref(), Some("char_502_nblade"));

        let dir = std::env::temp_dir();
        let pid = std::process::id();

        // 损坏的 JSON：不 panic，嵌入表原样保留。
        let bad = dir.join(format!("char_table_test_bad_{pid}.json"));
        std::fs::write(&bad, "{ definitely not json").expect("write temp file");
        refresh_from_file(&bad);
        assert_eq!(name_to_id("夜刀").as_deref(), Some("char_502_nblade"));

        // 合法 overlay：使用测试专属 charId/名字，避免影响其它用例。
        let good = dir.join(format!("char_table_test_good_{pid}.json"));
        std::fs::write(
            &good,
            r#"{"char_9998_zzztest": {"name": "泽兹测试干员", "appellation": "Zzztest"}}"#,
        )
        .expect("write temp file");
        refresh_from_file(&good);
        assert_eq!(
            name_to_id("泽兹测试干员").as_deref(),
            Some("char_9998_zzztest")
        );
        assert_eq!(name_to_id("Zzztest").as_deref(), Some("char_9998_zzztest"));
        assert_eq!(
            id_to_name("char_9998_zzztest").as_deref(),
            Some("泽兹测试干员")
        );

        // 同一文件再刷一次：指纹一致直接跳过，结果保持稳定。
        refresh_from_file(&good);
        assert_eq!(
            name_to_id("泽兹测试干员").as_deref(),
            Some("char_9998_zzztest")
        );

        let _ = std::fs::remove_file(&bad);
        let _ = std::fs::remove_file(&good);
    }
}
