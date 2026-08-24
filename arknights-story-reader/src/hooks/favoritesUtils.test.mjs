import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_FAVORITES,
  collectFavoriteGroupStoryIds,
  parseFavoritesStorage,
  reconcileFavoritesState,
  sanitizeFavoriteGroupMap,
  serializeFavoritesState,
} from "./favoritesUtils.ts";

const story = (storyId, overrides = {}) => ({
  storyId,
  storyName: `剧情 ${storyId}`,
  storyCode: `${storyId}-1`,
  storyGroup: "测试组",
  storySort: 1,
  storyTxt: `${storyId}.txt`,
  storyInfo: `${storyId}.info.txt`,
  storyReviewType: "MAIN",
  unLockType: "NONE",
  ...overrides,
});

test("旧版根级收藏表可迁移", () => {
  const parsed = parseFavoritesStorage(JSON.stringify({ a: story("a") }));
  assert.deepEqual(parsed.stories.a, story("a"));
  assert.deepEqual(parsed.groups, {});
});

test("收藏 map 使用 StoryEntry 的真实 storyId 修复脏 key", () => {
  const parsed = parseFavoritesStorage(
    JSON.stringify({ stories: { wrong: story("actual") }, groups: {} })
  );
  assert.equal(parsed.stories.wrong, undefined);
  assert.equal(parsed.stories.actual.storyId, "actual");
});

test("损坏 JSON 由调用方捕获而不是悄悄篡改", () => {
  assert.throws(() => parseFavoritesStorage("{broken"));
});

test("无内容返回共享空状态", () => {
  assert.equal(parseFavoritesStorage(null), EMPTY_FAVORITES);
});

test("收藏序列化保留 storyCode null 清除值", () => {
  const state = { stories: { a: story("a", { storyCode: null }) }, groups: {} };
  const roundTrip = parseFavoritesStorage(serializeFavoritesState(state));
  assert.equal(roundTrip.stories.a.storyCode, null);
  assert.match(serializeFavoritesState(state), /"storyCode":null/);
});

test("分组清洗去除 ghost 成员并规范化类型与 id", () => {
  const groups = sanitizeFavoriteGroupMap({
    group: {
      id: "wrong-id",
      name: "",
      type: "invalid",
      storyIds: ["a", "ghost", "a"],
      stories: { staleKey: story("a") },
    },
  });
  assert.equal(groups.group.id, "group");
  assert.equal(groups.group.name, "group");
  assert.equal(groups.group.type, "other");
  assert.deepEqual(groups.group.storyIds, ["a"]);
  assert.deepEqual(Object.keys(groups.group.stories), ["a"]);
});

test("分组成员集合按唯一 storyId 计数", () => {
  const ids = collectFavoriteGroupStoryIds({
    one: {
      id: "one",
      name: "one",
      type: "other",
      storyIds: ["a", "b"],
      stories: { a: story("a"), b: story("b") },
    },
    two: {
      id: "two",
      name: "two",
      type: "other",
      storyIds: ["b", "c"],
      stories: { b: story("b"), c: story("c") },
    },
  });
  assert.deepEqual([...ids], ["a", "b", "c"]);
});

test("换包后单章标题、简介路径和 null 关卡号一起刷新", () => {
  const old = story("a", {
    storyName: "旧标题",
    storyCode: "OLD-1",
    storyInfo: "old.info.txt",
  });
  const fresh = story("a", {
    storyName: "新标题",
    storyCode: null,
    storyInfo: "new.info.txt",
  });
  const next = reconcileFavoritesState(
    { stories: { a: old }, groups: {} },
    { entries: [fresh], groups: [] }
  );
  assert.equal(next.stories.a.storyName, "新标题");
  assert.equal(next.stories.a.storyInfo, "new.info.txt");
  assert.equal(next.stories.a.storyCode, null);
});

test("整组收藏随 live catalog 增删成员并刷新组摘要", () => {
  const aOld = story("a", { storyName: "A old" });
  const aNew = story("a", { storyName: "A new" });
  const b = story("b");
  const previous = {
    stories: {},
    groups: {
      event: {
        id: "event",
        name: "旧活动名",
        type: "other",
        storyIds: ["a"],
        stories: { a: aOld },
      },
    },
  };
  const next = reconcileFavoritesState(previous, {
    entries: [aNew, b],
    groups: [{ id: "event", name: "新活动名", type: "activity", stories: [aNew, b] }],
  });
  assert.equal(next.groups.event.name, "新活动名");
  assert.equal(next.groups.event.type, "activity");
  assert.deepEqual(next.groups.event.storyIds, ["a", "b"]);
  assert.equal(next.groups.event.stories.a.storyName, "A new");
});

test("目录对账不会把用户明确排除的章节加回来", () => {
  const a = story("a");
  const b = story("b");
  const previous = {
    stories: {},
    groups: {
      event: {
        id: "event",
        name: "活动",
        type: "activity",
        storyIds: ["a"],
        stories: { a },
        excludedStoryIds: ["b"],
      },
    },
  };
  const next = reconcileFavoritesState(previous, {
    entries: [a, b],
    groups: [{ id: "event", name: "活动", type: "activity", stories: [a, b] }],
  });
  assert.equal(next, previous, "内容未变时应保留引用并避免空写");
  assert.deepEqual(next.groups.event.storyIds, ["a"]);
});

test("空目录或 IPC 失败后的空快照不当作卸载", () => {
  const previous = { stories: { a: story("a") }, groups: {} };
  assert.equal(reconcileFavoritesState(previous, { entries: [], groups: [] }), previous);
});

test("目录内容完全一致时不触发 localStorage 回写", () => {
  const a = story("a");
  const previous = { stories: { a }, groups: {} };
  assert.equal(reconcileFavoritesState(previous, { entries: [{ ...a }], groups: [] }), previous);
});

test("未加载到的收藏组保留成员但刷新可见条目", () => {
  const old = story("a", { storyName: "旧" });
  const fresh = story("a", { storyName: "新" });
  const previous = {
    stories: {},
    groups: {
      hidden: {
        id: "hidden",
        name: "尚未加载的分类",
        type: "other",
        storyIds: ["a"],
        stories: { a: old },
      },
    },
  };
  const next = reconcileFavoritesState(previous, { entries: [fresh], groups: [] });
  assert.deepEqual(next.groups.hidden.storyIds, ["a"]);
  assert.equal(next.groups.hidden.stories.a.storyName, "新");
});
