use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoryEntry {
    #[serde(rename = "storyId")]
    pub story_id: String,
    #[serde(rename = "storyName")]
    pub story_name: String,
    #[serde(rename = "storyCode")]
    pub story_code: Option<String>,
    #[serde(rename = "storyGroup")]
    pub story_group: String,
    #[serde(rename = "storySort")]
    pub story_sort: i32,
    #[serde(rename = "avgTag")]
    pub avg_tag: Option<String>,
    #[serde(rename = "storyTxt")]
    pub story_txt: String,
    #[serde(rename = "storyInfo")]
    pub story_info: Option<String>,
    #[serde(rename = "storyReviewType")]
    pub story_review_type: String,
    #[serde(rename = "unLockType")]
    pub unlock_type: String,
    // 额外元数据
    #[serde(rename = "storyDependence")]
    pub story_dependence: Option<String>,
    #[serde(rename = "storyCanShow")]
    pub story_can_show: Option<i32>,
    #[serde(rename = "storyCanEnter")]
    pub story_can_enter: Option<i32>,
    #[serde(rename = "stageCount")]
    pub stage_count: Option<i32>,
    #[serde(rename = "requiredStages")]
    pub required_stages: Option<Vec<RequiredStage>>,
    #[serde(rename = "costItemType")]
    pub cost_item_type: Option<String>,
    #[serde(rename = "costItemId")]
    pub cost_item_id: Option<String>,
    #[serde(rename = "costItemCount")]
    pub cost_item_count: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequiredStage {
    #[serde(rename = "stageId")]
    pub stage_id: String,
    #[serde(rename = "minState")]
    pub min_state: String,
    #[serde(rename = "maxState")]
    pub max_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chapter {
    #[serde(rename = "chapterId")]
    pub chapter_id: String,
    #[serde(rename = "chapterName")]
    pub chapter_name: String,
    #[serde(rename = "chapterName2")]
    pub chapter_name2: String,
    #[serde(rename = "chapterIndex")]
    pub chapter_index: i32,
    #[serde(rename = "preposedChapterId")]
    pub preposed_chapter_id: Option<String>,
    #[serde(rename = "startZoneId")]
    pub start_zone_id: String,
    #[serde(rename = "endZoneId")]
    pub end_zone_id: String,
    #[serde(rename = "chapterEndStageId")]
    pub chapter_end_stage_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Activity {
    pub id: String,
    pub name: String,
    #[serde(rename = "entryType")]
    pub entry_type: String,
    #[serde(rename = "actType")]
    pub act_type: String,
    #[serde(rename = "startTime")]
    pub start_time: i64,
    #[serde(rename = "endTime")]
    pub end_time: i64,
    #[serde(rename = "infoUnlockDatas")]
    pub info_unlock_datas: Vec<StoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum StorySegment {
    Dialogue {
        #[serde(rename = "characterName")]
        character_name: String,
        text: String,
        /// 可选的对话位置（例如右侧头像）
        #[serde(skip_serializing_if = "Option::is_none")]
        position: Option<String>,
    },
    Narration {
        text: String,
    },
    Decision {
        options: Vec<String>,
        /// 对应每个选项的值（若存在）
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        values: Vec<String>,
    },
    System {
        #[serde(rename = "speaker")]
        speaker: Option<String>,
        text: String,
    },
    Subtitle {
        text: String,
        #[serde(rename = "alignment")]
        alignment: Option<String>,
    },
    Sticker {
        text: String,
        #[serde(rename = "alignment")]
        alignment: Option<String>,
    },
    Header {
        title: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedStoryContent {
    pub segments: Vec<StorySegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoryCategory {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub category_type: String,
    pub stories: Vec<StoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    #[serde(rename = "storyId")]
    pub story_id: String,
    #[serde(rename = "storyName")]
    pub story_name: String,
    #[serde(rename = "matchedText")]
    pub matched_text: String,
    pub category: String,
}

/// Extended search response with facet counts and truncation info. Used by
/// `search_stories_ex` so that the frontend can render category filters and
/// a "showing 500 / N" notice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResultsPage {
    pub results: Vec<SearchResult>,
    #[serde(rename = "totalMatched")]
    pub total_matched: usize,
    pub truncated: bool,
    /// Categories → count map (FTS-only path populates, linear scan contributes
    /// whatever it can).
    #[serde(default)]
    pub facets: std::collections::BTreeMap<String, usize>,
}

/// A single segment hit from the segment-level index. Enables precise
/// "jump to this paragraph" search results.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentHit {
    #[serde(rename = "storyId")]
    pub story_id: String,
    #[serde(rename = "storyName")]
    pub story_name: String,
    pub category: String,
    #[serde(rename = "segmentIndex")]
    pub segment_index: usize,
    #[serde(rename = "segmentType")]
    pub segment_type: String,
    #[serde(rename = "characterName")]
    pub character_name: Option<String>,
    #[serde(rename = "matchedText")]
    pub matched_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentSearchPage {
    pub hits: Vec<SegmentHit>,
    #[serde(rename = "totalMatched")]
    pub total_matched: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchDebugResponse {
    pub results: Vec<SearchResult>,
    pub logs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoryIndexStatus {
    pub ready: bool,
    pub total: usize,
    #[serde(rename = "lastBuiltAt")]
    pub last_built_at: Option<i64>,
}
