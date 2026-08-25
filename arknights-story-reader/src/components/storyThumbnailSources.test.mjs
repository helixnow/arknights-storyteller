import assert from "node:assert/strict";
import test from "node:test";

import {
  getStoryThumbnailSources,
  isThumbnailVisuallyLoaded,
  thumbnailCandidateTransition,
} from "./storyThumbnailSources.ts";

test("篇内插画始终排在目录封面之前", () => {
  assert.deepEqual(
    getStoryThumbnailSources(
      {
        storyTxt: "activities/act9d0/level_act9d0_01",
        storyGroup: "act9d0",
        storyPic: "storyEntryPic_act9d0",
      },
      { kind: "background", token: "$bg_snow" }
    ),
    [
      { kind: "background", token: "$bg_snow" },
      { kind: "activity_kv", token: "storyEntryPic_act9d0" },
      { kind: "activity_kv", token: "act9d0" },
    ]
  );
});

test("活动 storyPic 原样保留 act_ 前缀并优先于 group 猜测", () => {
  assert.deepEqual(
    getStoryThumbnailSources(
      {
        storyTxt: "ACTIVITIES\\act_fun\\story_1",
        storyGroup: "act_fun",
        storyPic: " act_17side_entrypic.png ",
      },
      null
    ),
    [
      { kind: "activity_kv", token: "act_17side_entrypic.png" },
      { kind: "activity_kv", token: "act_fun" },
    ]
  );
});

test("storyPic 与 group 相同不会重复请求同一组活动候选", () => {
  assert.deepEqual(
    getStoryThumbnailSources(
      {
        storyTxt: "activities/act1/story_1",
        storyGroup: "act1",
        storyPic: "act1",
      },
      null
    ),
    [{ kind: "activity_kv", token: "act1" }]
  );
});

test("主线按 storyGroup 解析章节封面", () => {
  assert.deepEqual(
    getStoryThumbnailSources(
      {
        storyTxt: "obt/main/level_main_08-01",
        storyGroup: "main_8",
        storyPic: "不应冒充活动 KV",
      },
      null
    ),
    [{ kind: "chapter_cover", token: "main_8" }]
  );
});

test("旧图仍是首选时原位保留", () => {
  assert.deepEqual(thumbnailCandidateTransition(["cover", "fallback"], "cover"), {
    cursor: 0,
    loaded: true,
    bridgeUrl: null,
  });
});

test("更优的篇内插画晚到时升级首选并用旧封面垫底", () => {
  assert.deepEqual(
    thumbnailCandidateTransition(["story-image", "cover", "fallback"], "cover"),
    {
      cursor: 0,
      loaded: false,
      bridgeUrl: "cover",
    }
  );
});

test("换包移除旧 URL 时立刻丢弃旧图", () => {
  assert.deepEqual(thumbnailCandidateTransition(["new-image", "new-cover"], "old-image"), {
    cursor: 0,
    loaded: false,
    bridgeUrl: null,
  });
});

test("已加载状态不能沿用到刚切换的新候选 URL", () => {
  assert.equal(isThumbnailVisuallyLoaded(true, "old-cover", "new-cover"), false);
  assert.equal(isThumbnailVisuallyLoaded(true, "same-cover", "same-cover"), true);
  assert.equal(isThumbnailVisuallyLoaded(false, "same-cover", "same-cover"), false);
  assert.equal(isThumbnailVisuallyLoaded(true, "same-cover", null), false);
});
