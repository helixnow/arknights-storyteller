//! 干员名字 ↔ charId 映射。
//!
//! 编译时把 `assets/char_map.json` 嵌入 binary，避免首次启动前拿不到
//! character_table.json 时人物头像还是空的问题。运行时若 ArknightsGameData
//! 已经解压，还会做一次 overlay 以覆盖新干员。

use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

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

/// 用运行时的 `character_table.json` 覆盖嵌入数据。静默失败。
pub fn refresh_from_file(path: &std::path::Path) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    let Some(obj) = json.as_object() else {
        return;
    };

    let mut guard = RUNTIME.write().expect("character index poisoned");
    for (cid, v) in obj.iter() {
        if !cid.starts_with("char_") {
            continue;
        }
        let name = v
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        guard.char_id_to_name.insert(cid.clone(), name.clone());
        guard.name_to_char_id.entry(name).or_insert(cid.clone());
        if let Some(alias) = v
            .get("appellation")
            .and_then(|x| x.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            guard
                .name_to_char_id
                .entry(alias.to_string())
                .or_insert(cid.clone());
        }
    }
}

/// 导出当前索引（给前端一次性拿走缓存，避免频繁查询）。
pub fn snapshot() -> CharacterIndex {
    RUNTIME.read().expect("character index poisoned").clone()
}

/// 按中文名/别名找 charId。
pub fn name_to_id(name: &str) -> Option<String> {
    let n = name.trim();
    if n.is_empty() {
        return None;
    }
    RUNTIME
        .read()
        .ok()?
        .name_to_char_id
        .get(n)
        .cloned()
}

/// 按 charId 查中文显示名（用于 parser 回填 dialogue.character_name）。
#[allow(dead_code)]
pub fn id_to_name(char_id: &str) -> Option<String> {
    RUNTIME
        .read()
        .ok()?
        .char_id_to_name
        .get(char_id)
        .cloned()
}
