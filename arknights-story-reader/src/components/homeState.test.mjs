import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveStreakDays,
  localDayKey,
  nextReadingStreak,
  normalizeStreakInfo,
  streakDayRelation,
} from "./homeState.ts";

test("本地日期键固定为 YYYY-MM-DD", () => {
  assert.equal(localDayKey(new Date(2026, 0, 2, 12)), "2026-01-02");
});

test("连签存储只接受有限非负整数和真实日期", () => {
  assert.deepEqual(
    normalizeStreakInfo({
      currentStreak: 3.9,
      lastReadOn: "2026-08-24",
      totalDays: 8.7,
    }),
    { currentStreak: 3, lastReadOn: "2026-08-24", totalDays: 8 }
  );
  assert.deepEqual(
    normalizeStreakInfo({
      currentStreak: 9,
      lastReadOn: "2026-08-24",
      totalDays: 3,
    }),
    { currentStreak: 3, lastReadOn: "2026-08-24", totalDays: 3 }
  );
  assert.deepEqual(
    normalizeStreakInfo({
      currentStreak: Number.POSITIVE_INFINITY,
      lastReadOn: "2026-02-31",
      totalDays: 5,
    }),
    { currentStreak: 0, lastReadOn: "", totalDays: 5 }
  );
  assert.deepEqual(normalizeStreakInfo(null), {
    currentStreak: 0,
    lastReadOn: "",
    totalDays: 0,
  });
});

test("有效阅读日跨月、跨年和闰日都按自然日判断", () => {
  assert.equal(streakDayRelation("2025-12-31", "2026-01-01"), "yesterday");
  assert.equal(streakDayRelation("2024-02-29", "2024-03-01"), "yesterday");
  assert.equal(streakDayRelation("2026-09-01", "2026-08-31"), "tomorrow");
  assert.equal(streakDayRelation("2026-02-31", "2026-03-01"), "invalid");
});

test("今天和昨天的连签可展示，断签归零", () => {
  const streak = { currentStreak: 12, lastReadOn: "2026-08-24", totalDays: 30 };
  assert.equal(effectiveStreakDays(streak, "2026-08-24"), 12);
  assert.equal(effectiveStreakDays(streak, "2026-08-25"), 12);
  assert.equal(effectiveStreakDays(streak, "2026-08-26"), 0);
});

test("只容忍一日时区回拨，不展示遥远未来的旧连签", () => {
  const oneDayAhead = {
    currentStreak: 7,
    lastReadOn: "2026-08-25",
    totalDays: 20,
  };
  assert.equal(effectiveStreakDays(oneDayAhead, "2026-08-24"), 7);
  assert.equal(
    effectiveStreakDays({ ...oneDayAhead, lastReadOn: "2026-09-24" }, "2026-08-24"),
    0
  );
});

test("同一天再次阅读不重复累计", () => {
  assert.deepEqual(
    nextReadingStreak(
      { currentStreak: 4, lastReadOn: "2026-08-24", totalDays: 9 },
      "2026-08-24"
    ),
    { currentStreak: 4, lastReadOn: "2026-08-24", totalDays: 9 }
  );
});

test("隔日阅读推进连签，跨日断签重新从一天开始", () => {
  assert.deepEqual(
    nextReadingStreak(
      { currentStreak: 4, lastReadOn: "2026-08-23", totalDays: 9 },
      "2026-08-24"
    ),
    { currentStreak: 5, lastReadOn: "2026-08-24", totalDays: 10 }
  );
  assert.deepEqual(
    nextReadingStreak(
      { currentStreak: 4, lastReadOn: "2026-08-20", totalDays: 9 },
      "2026-08-24"
    ),
    { currentStreak: 1, lastReadOn: "2026-08-24", totalDays: 10 }
  );
});

test("一日时钟回拨只校正日期，不虚增累计天数", () => {
  assert.deepEqual(
    nextReadingStreak(
      { currentStreak: 4, lastReadOn: "2026-08-25", totalDays: 9 },
      "2026-08-24"
    ),
    { currentStreak: 4, lastReadOn: "2026-08-24", totalDays: 9 }
  );
});

test("连签与累计天数在安全整数上限饱和", () => {
  assert.deepEqual(
    nextReadingStreak(
      {
        currentStreak: Number.MAX_SAFE_INTEGER,
        lastReadOn: "2026-08-24",
        totalDays: Number.MAX_SAFE_INTEGER,
      },
      "2026-08-25"
    ),
    {
      currentStreak: Number.MAX_SAFE_INTEGER,
      lastReadOn: "2026-08-25",
      totalDays: Number.MAX_SAFE_INTEGER,
    }
  );
});
