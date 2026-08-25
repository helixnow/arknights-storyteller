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
//! - overlay 以指纹（路径 + 大小 + mtime）去重；数据包变化时从嵌入表
//!   重新构建，不能让上一包已删除的角色/别名残留在运行时索引。

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
    /// 文件内容指纹。只看 size + mtime 会漏掉「同路径原子换包且归档保留
    /// 时间戳、恰好等长」的情况，继续把上一包的角色表当成当前快照。
    content_hash: u64,
}

fn content_hash(raw: &str) -> u64 {
    // FNV-1a 足够用作进程内变更检测，且实现稳定、无额外依赖。
    raw.as_bytes()
        .iter()
        .fold(0xcbf29ce484222325, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
}

fn fingerprint(path: &Path, raw: &str) -> Option<TableFingerprint> {
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
        content_hash: content_hash(raw),
    })
}

/// 只有完全相同的文件才可跳过。用户允许导入旧数据包，mtime 变小是合法
/// 回滚，不是并发旧响应；把它判 stale 会让剧情已经回滚而角色索引仍停在新包。
fn is_duplicate_refresh(applied: Option<&TableFingerprint>, incoming: &TableFingerprint) -> bool {
    applied == Some(incoming)
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

fn canonical_char_id(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let prefix = trimmed.get(.."char_".len())?;
    if !prefix.eq_ignore_ascii_case("char_") {
        return None;
    }
    let without_art = trimmed
        .split(|c| c == '#' || c == '$')
        .next()
        .unwrap_or(trimmed)
        .trim();
    (without_art.len() > "char_".len()).then(|| without_art.to_ascii_lowercase())
}

fn insert_name_mapping(index: &mut CharacterIndex, name: &str, char_id: &str) {
    let name = name.trim();
    if name.is_empty() {
        return;
    }
    index
        .name_to_char_id
        .entry(name.to_string())
        .or_insert_with(|| char_id.to_string());
    let folded = name.to_ascii_lowercase();
    index
        .name_to_char_id
        .entry(folded)
        .or_insert_with(|| char_id.to_string());
}

impl CharacterIndex {
    fn from_embedded() -> Self {
        match serde_json::from_str::<EmbeddedPayload>(EMBEDDED_MAP) {
            Ok(p) => {
                let mut index = Self::default();
                let mut id_names: Vec<_> = p.ci2name.into_iter().collect();
                id_names.sort_by(|a, b| a.0.cmp(&b.0));
                for (raw_id, raw_name) in id_names {
                    let Some(char_id) = canonical_char_id(&raw_id) else {
                        continue;
                    };
                    let name = raw_name.trim();
                    if name.is_empty() {
                        continue;
                    }
                    index.char_id_to_name.insert(char_id, name.to_string());
                }

                // 嵌入表的 name2ci 是同名分形的权威选择，先按稳定顺序落它；
                // 目标不存在的悬空项不进入快照。
                let mut aliases: Vec<_> = p.name2ci.into_iter().collect();
                aliases.sort();
                for (alias, raw_id) in aliases {
                    let Some(char_id) = canonical_char_id(&raw_id) else {
                        continue;
                    };
                    if index.char_id_to_name.contains_key(&char_id) {
                        insert_name_mapping(&mut index, &alias, &char_id);
                    }
                }

                // ci2name 也要能反查；重复显示名保持上面的权威映射或最小 id。
                let mut display_names: Vec<_> = index
                    .char_id_to_name
                    .iter()
                    .map(|(id, name)| (id.clone(), name.clone()))
                    .collect();
                display_names.sort();
                for (char_id, name) in display_names {
                    insert_name_mapping(&mut index, &name, &char_id);
                }
                index
            }
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
        let Some(char_id) = canonical_char_id(cid) else {
            continue;
        };
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
            char_id,
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
        let Some(char_id) = canonical_char_id(&e.char_id) else {
            continue;
        };
        index
            .char_id_to_name
            .insert(char_id.clone(), e.name.clone());
        insert_name_mapping(index, &e.name, &char_id);
        if let Some(alias) = &e.appellation {
            insert_name_mapping(index, alias, &char_id);
        }
    }
}

fn index_from_entries(entries: &[ParsedEntry]) -> CharacterIndex {
    let mut index = CharacterIndex::from_embedded();
    apply_entries(&mut index, entries);
    index
}

/// 用运行时的 `character_table.json` 覆盖嵌入数据。静默失败，绝不 panic。
/// 同一份文件只 overlay 一次；数据包换了（大小或 mtime 变化）会重新读；
/// 每次变化都从嵌入表重建，上一数据包独有的条目不会泄漏到新索引。
pub fn refresh_from_file(path: &Path) {
    // OVERLAID 写锁贯穿整个刷新：既让并发调用只解析一次这份十几 MB 的
    // JSON，也保证去重判断与指纹更新是原子的。锁毒化就地恢复——
    // 指纹只是缓存优化，最坏情况多解析一次。
    let mut overlaid = OVERLAID.write().unwrap_or_else(PoisonError::into_inner);
    // 读失败（权限、竞争删除等）视作瞬态错误：不记指纹，下次再试。
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    // 在读完后再取 metadata + 内容摘要：归档换包可能保留原 mtime，甚至新旧
    // JSON 恰好等长；只比较 path/len/mtime 会静默复用上一包快照。重复调用
    // 仍会省掉昂贵的 JSON parse，只多一次顺序读与线性摘要。
    let Some(current) = fingerprint(path, &raw) else {
        return;
    };
    if is_duplicate_refresh(overlaid.as_ref(), &current) {
        return;
    }

    let next = match parse_character_table(&raw) {
        Some(entries) => index_from_entries(&entries),
        None => {
            eprintln!(
                "[char-table] {} is not a valid character table; keeping embedded map",
                path.display()
            );
            CharacterIndex::from_embedded()
        }
    };
    *RUNTIME.write().unwrap_or_else(PoisonError::into_inner) = next;

    // 解析成败都记录指纹：同一份字节重复解析结果不会变，解析失败也没有
    // 必要每次冷启动重来一遍；文件内容一变（len/mtime 变化）自然会重试。
    *overlaid = Some(current);
}

/// 导出当前索引（给前端一次性拿走缓存，避免频繁查询）。
pub fn snapshot() -> CharacterIndex {
    // 数据目录被卸载，或换入的是只含剧情表的最小合法包时，commands 层
    // 拿不到 character_table_path，因而不会调用 refresh_from_file。这里
    // 必须主动撤掉上一包的 overlay，否则 snapshot 会永久回传旧角色索引。
    let mut overlaid = OVERLAID.write().unwrap_or_else(PoisonError::into_inner);
    if overlaid.as_ref().is_some_and(|applied| {
        std::fs::metadata(&applied.path)
            .map(|meta| !meta.is_file())
            .unwrap_or(true)
    }) {
        *RUNTIME.write().unwrap_or_else(PoisonError::into_inner) = CharacterIndex::from_embedded();
        *overlaid = None;
    }
    drop(overlaid);
    RUNTIME
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// 按中文名/别名找 charId。名字带精英皮肤后缀（如 `阿米娅#2`）时会
/// 去掉 `#N` 再查一次。
pub fn name_to_id(name: &str) -> Option<String> {
    let index = RUNTIME.read().unwrap_or_else(PoisonError::into_inner);
    lookup_name(&index, name)
}

fn lookup_name(index: &CharacterIndex, name: &str) -> Option<String> {
    let n = name.trim();
    if n.is_empty() {
        return None;
    }
    if let Some(id) = index
        .name_to_char_id
        .get(n)
        .or_else(|| index.name_to_char_id.get(&n.to_ascii_lowercase()))
    {
        return Some(id.clone());
    }
    let base = n.split('#').next().map(str::trim).unwrap_or("");
    if base.is_empty() || base == n {
        return None;
    }
    index
        .name_to_char_id
        .get(base)
        .or_else(|| index.name_to_char_id.get(&base.to_ascii_lowercase()))
        .cloned()
}

/// 按 charId 查中文显示名（用于 parser 回填 dialogue.character_name）。
/// 容忍带皮肤后缀的 charId（`char_002_amiya#2`）。
#[allow(dead_code)]
pub fn id_to_name(char_id: &str) -> Option<String> {
    let index = RUNTIME.read().unwrap_or_else(PoisonError::into_inner);
    lookup_id(&index, char_id)
}

fn lookup_id(index: &CharacterIndex, char_id: &str) -> Option<String> {
    let id = canonical_char_id(char_id)?;
    if let Some(name) = index.char_id_to_name.get(&id) {
        return Some(name.clone());
    }
    // 立绘 token 的第四段起是 `_1` / `_winter` / `_epoque` 等美术后缀。
    let parts: Vec<&str> = id.split('_').collect();
    if parts.len() > 3 && parts[1].chars().all(|c| c.is_ascii_digit()) {
        return index.char_id_to_name.get(&parts[..3].join("_")).cloned();
    }
    None
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
            index
                .char_id_to_name
                .get("char_285_medic2")
                .map(String::as_str),
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

    #[test]
    fn embedded_snapshot_is_bidirectionally_closed_and_case_folded() {
        let index = CharacterIndex::from_embedded();
        for (id, name) in &index.char_id_to_name {
            let mapped = index
                .name_to_char_id
                .get(name)
                .unwrap_or_else(|| panic!("display name {name:?} for {id:?} cannot map back"));
            assert!(
                index.char_id_to_name.contains_key(mapped),
                "display name {name:?} maps to dangling id {mapped:?}"
            );
        }
        assert_eq!(
            index.name_to_char_id.get("lancet-2").map(String::as_str),
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

    #[test]
    fn parse_and_lookup_canonicalize_ascii_case() {
        let entries = parse_character_table(
            r#"{"CHAR_9998_CASETEST": {"name": "测试", "appellation": "CaseName"}}"#,
        )
        .expect("valid json");
        assert_eq!(
            entries,
            vec![entry("char_9998_casetest", "测试", Some("CaseName"))]
        );

        let mut index = CharacterIndex::default();
        apply_entries(&mut index, &entries);
        assert_eq!(
            lookup_name(&index, "casename").as_deref(),
            Some("char_9998_casetest")
        );
        assert_eq!(
            lookup_name(&index, "CASENAME#2").as_deref(),
            Some("char_9998_casetest")
        );
        assert_eq!(
            lookup_id(&index, " CHAR_9998_CASETEST_WINTER#4 ").as_deref(),
            Some("测试")
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
            index
                .char_id_to_name
                .get("char_9999_fake")
                .map(String::as_str),
            Some("阿米娅")
        );
    }

    #[test]
    fn rebuilding_for_a_new_package_drops_old_overlay_entries() {
        let old = index_from_entries(&[entry(
            "char_9997_old_package_only",
            "旧包专属测试干员",
            Some("OldPackageOnly"),
        )]);
        assert_eq!(
            old.name_to_char_id
                .get("旧包专属测试干员")
                .map(String::as_str),
            Some("char_9997_old_package_only")
        );

        let new = index_from_entries(&[entry(
            "char_9996_new_package_only",
            "新包专属测试干员",
            Some("NewPackageOnly"),
        )]);
        assert!(
            !new.char_id_to_name
                .contains_key("char_9997_old_package_only"),
            "新包索引不能残留上一包已删除的 charId"
        );
        assert!(
            !new.name_to_char_id.contains_key("旧包专属测试干员")
                && !new.name_to_char_id.contains_key("OldPackageOnly"),
            "新包索引不能残留上一包已删除的名字/别名"
        );
        assert_eq!(
            new.name_to_char_id
                .get("新包专属测试干员")
                .map(String::as_str),
            Some("char_9996_new_package_only")
        );
    }

    // ---------- 刷新去重判定 ----------

    fn fp(path: &str, len: u64, mtime: i128) -> TableFingerprint {
        TableFingerprint {
            path: PathBuf::from(path),
            len,
            modified_nanos: mtime,
            content_hash: len ^ (mtime as u64),
        }
    }

    #[test]
    fn duplicate_refresh_detection_allows_package_rollbacks() {
        let applied = fp("/data/character_table.json", 100, 2_000);

        // 尚未 overlay 过：必须读取。
        assert!(!is_duplicate_refresh(None, &applied));
        // 完全相同的指纹：已处理过，跳过。
        assert!(is_duplicate_refresh(Some(&applied), &applied.clone()));
        // 同一路径、更旧的 mtime 是合法的数据包回滚，必须重新应用。
        assert!(!is_duplicate_refresh(
            Some(&applied),
            &fp("/data/character_table.json", 90, 1_000)
        ));
        // 同一路径、更新的 mtime：正常刷新。
        assert!(!is_duplicate_refresh(
            Some(&applied),
            &fp("/data/character_table.json", 110, 3_000)
        ));
        // 同一路径、mtime 相同但大小变了：内容变化，重新应用。
        assert!(!is_duplicate_refresh(
            Some(&applied),
            &fp("/data/character_table.json", 110, 2_000)
        ));
        // 路径不同（数据目录迁移）：不算过期。
        assert!(!is_duplicate_refresh(
            Some(&applied),
            &fp("/elsewhere/character_table.json", 90, 1_000)
        ));
        // mtime 未知（-1）：无法比较新旧，宁可重新应用。
        assert!(!is_duplicate_refresh(
            Some(&fp("/data/character_table.json", 100, -1)),
            &fp("/data/character_table.json", 90, 1_000)
        ));
        assert!(!is_duplicate_refresh(
            Some(&applied),
            &fp("/data/character_table.json", 90, -1)
        ));
    }

    #[test]
    fn duplicate_refresh_detection_includes_file_contents() {
        let mut old = fp("/data/character_table.json", 100, 2_000);
        let mut replacement = old.clone();
        old.content_hash = content_hash(r#"{"char_a":{"name":"甲"}}"#);
        replacement.content_hash = content_hash(r#"{"char_b":{"name":"乙"}}"#);

        assert_eq!(old.path, replacement.path);
        assert_eq!(old.len, replacement.len);
        assert_eq!(old.modified_nanos, replacement.modified_nanos);
        assert!(
            !is_duplicate_refresh(Some(&old), &replacement),
            "同路径、等长、同 mtime 的换包仍必须刷新"
        );
    }

    // ---------- 查询 ----------

    #[test]
    fn name_lookup_trims_and_handles_skin_suffix() {
        assert_eq!(name_to_id("夜刀").as_deref(), Some("char_502_nblade"));
        assert_eq!(name_to_id("  夜刀  ").as_deref(), Some("char_502_nblade"));
        // 精英皮肤后缀 `#N` 去掉后再查。
        assert_eq!(name_to_id("夜刀#2").as_deref(), Some("char_502_nblade"));
        assert_eq!(
            name_to_id("夜刀#2#extra").as_deref(),
            Some("char_502_nblade")
        );
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
        // 换包后同一路径若变成目录（损坏/恶意 ZIP），metadata 仍成功；
        // 只检查“路径存在”会让上一包 overlay 永久残留。
        std::fs::create_dir(&good).expect("replace character table with a directory");
        let reset = snapshot();
        assert!(
            !reset.name_to_char_id.contains_key("泽兹测试干员"),
            "运行时 character_table 消失后必须撤掉上一包 overlay"
        );
        assert_eq!(
            reset.name_to_char_id.get("夜刀").map(String::as_str),
            Some("char_502_nblade"),
            "撤掉 overlay 后仍应保留嵌入索引"
        );
        let _ = std::fs::remove_dir(&good);
    }
}
