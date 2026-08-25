export interface ReadingStreakInfo {
  currentStreak: number;
  lastReadOn: string;
  totalDays: number;
}

const EMPTY_STREAK: ReadingStreakInfo = {
  currentStreak: 0,
  lastReadOn: "",
  totalDays: 0,
};

export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

/** 严格解析 YYYY-MM-DD；Date 自动进位出来的 2026-02-31 不算合法日期。 */
function dayOrdinal(key: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  // setUTCFullYear 避开 Date.UTC 对 0..99 年自动加 1900 的特殊规则。
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(date.getTime() / 86_400_000);
}

function safeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function incrementCount(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

/** localStorage 可能被旧版本或用户手改过，先恢复成可展示的有限非负整数。 */
export function normalizeStreakInfo(value: unknown): ReadingStreakInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...EMPTY_STREAK };
  }
  const candidate = value as Partial<ReadingStreakInfo>;
  const totalDays = safeCount(candidate.totalDays);
  const validLastReadOn =
    typeof candidate.lastReadOn === "string" && dayOrdinal(candidate.lastReadOn) !== null
      ? candidate.lastReadOn
      : "";
  if (!validLastReadOn) {
    return { currentStreak: 0, lastReadOn: "", totalDays };
  }
  return {
    currentStreak: Math.min(safeCount(candidate.currentStreak), totalDays),
    lastReadOn: validLastReadOn,
    totalDays,
  };
}

type StreakDayRelation = "yesterday" | "today" | "tomorrow" | "stale" | "invalid";

export function streakDayRelation(lastReadOn: string, today: string): StreakDayRelation {
  const last = dayOrdinal(lastReadOn);
  const current = dayOrdinal(today);
  if (last === null || current === null) return "invalid";
  const delta = last - current;
  if (delta === -1) return "yesterday";
  if (delta === 0) return "today";
  // 向西跨时区或手动小幅回拨时，盘上的「昨天」可能落在当前本地日期的明天。
  if (delta === 1) return "tomorrow";
  return "stale";
}

/**
 * 首页展示口径：最后阅读日在今天/昨天时连签仍有效；时区回拨一日也保留。
 * 更远的未来日期与坏日期都不可信，不能把旧数字原样展示。
 */
export function effectiveStreakDays(streak: ReadingStreakInfo, today: string): number {
  const normalized = normalizeStreakInfo(streak);
  const relation = streakDayRelation(normalized.lastReadOn, today);
  return relation === "today" || relation === "yesterday" || relation === "tomorrow"
    ? normalized.currentStreak
    : 0;
}

/** 打开一篇剧情后推进连签；当天重复阅读返回相同字段，不会再次累计。 */
export function nextReadingStreak(
  streak: ReadingStreakInfo,
  today: string
): ReadingStreakInfo {
  const current = normalizeStreakInfo(streak);
  const relation = streakDayRelation(current.lastReadOn, today);
  if (relation === "today") return current;
  if (relation === "tomorrow") {
    return { ...current, lastReadOn: today };
  }
  if (relation === "yesterday") {
    return {
      currentStreak: incrementCount(current.currentStreak),
      lastReadOn: today,
      totalDays: incrementCount(current.totalDays),
    };
  }
  return {
    currentStreak: 1,
    lastReadOn: today,
    totalDays: incrementCount(current.totalDays),
  };
}
