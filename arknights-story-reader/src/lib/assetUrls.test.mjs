/**
 * assetUrls 单元测试（node:test + node:assert，无额外依赖）。
 *
 * 覆盖：各镜像源 URL 拼接、`$` 前缀只剥一次、NPC 头像覆盖表、
 * 别名/原型链安全解析，以及 host 熔断 + 唤醒调度（用 mock timers，
 * 不真实等待，保持快速且确定）。
 *
 * 注意：熔断相关的模块级状态（deadUrls / hostStrikes / provenHosts）在
 * 同一测试文件内共享，因此每个用例使用独立的假 host（*.invalid），
 * 且用例按定义顺序串行执行。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveAssetCandidatesLocal,
  isAssetUrlDead,
  markAssetUrlDead,
  markAssetUrlAlive,
  pickLiveCandidate,
  hasRecoverableCandidate,
  subscribeAssetHealth,
  getAssetHealthVersion,
  hashHue,
  gradientFallbackBackground,
} from "./assetUrls.ts";

const YUANYAN = "https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main";
const FEXLI = "https://raw.githubusercontent.com/fexli/ArknightsResource/main";
const PUPPIIZ = "https://raw.githubusercontent.com/PuppiizSunniiz/Arknight-Images/main";

// ─────────────────────────────────────────────────────────────
// URL 拼接
// ─────────────────────────────────────────────────────────────

test("avatar：char_ id 依次产出内置 + 三个镜像源", () => {
  assert.deepEqual(resolveAssetCandidatesLocal("avatar", "char_002_amiya", null), [
    "/bundled/avatar/char_002_amiya.png",
    `${YUANYAN}/avatar/char_002_amiya.png`,
    `${FEXLI}/charpor/char_002_amiya.png`,
    `${PUPPIIZ}/avatars/char_002_amiya.png`,
  ]);
});

test("avatar：远程候选都是合法 URL 且 host / 仓库路径正确", () => {
  const remote = resolveAssetCandidatesLocal("avatar", "char_002_amiya", null).filter((u) =>
    u.startsWith("http")
  );
  assert.equal(remote.length, 3);
  const prefixes = [
    "/yuanyan3060/ArknightsGameResource/main/",
    "/fexli/ArknightsResource/main/",
    "/PuppiizSunniiz/Arknight-Images/main/",
  ];
  remote.forEach((u, i) => {
    const parsed = new URL(u);
    assert.equal(parsed.host, "raw.githubusercontent.com");
    assert.ok(parsed.pathname.startsWith(prefixes[i]), `${u} 应以 ${prefixes[i]} 开头`);
  });
});

test("avatar：char_ id 上的 #皮肤 后缀被剥掉", () => {
  assert.deepEqual(
    resolveAssetCandidatesLocal("avatar", "char_002_amiya#1", null),
    resolveAssetCandidatesLocal("avatar", "char_002_amiya", null)
  );
});

test("avatar：中文名经 nameToCharId 解析", () => {
  const index = { nameToCharId: { 阿米娅: "char_002_amiya" }, charIdToName: {} };
  assert.deepEqual(
    resolveAssetCandidatesLocal("avatar", "阿米娅", index),
    resolveAssetCandidatesLocal("avatar", "char_002_amiya", null)
  );
});

test("avatar：alias 经 charIdToName 反向表解析（大小写不敏感）", () => {
  const index = { nameToCharId: {}, charIdToName: { char_124_kroos: "克洛丝" } };
  assert.deepEqual(
    resolveAssetCandidatesLocal("avatar", "KROOS", index),
    resolveAssetCandidatesLocal("avatar", "char_124_kroos", null)
  );
});

test("avatar：constructor / toString 等原型链 key 不会误解析", () => {
  const index = { nameToCharId: {}, charIdToName: {} };
  assert.deepEqual(resolveAssetCandidatesLocal("avatar", "constructor", index), []);
  assert.deepEqual(resolveAssetCandidatesLocal("avatar", "toString", index), []);
  assert.deepEqual(resolveAssetCandidatesLocal("portrait", "hasOwnProperty", index), []);
});

test("avatar/portrait：NPC 覆盖表优先，且不追加镜像候选", () => {
  assert.deepEqual(resolveAssetCandidatesLocal("avatar", "普瑞赛斯", null), [
    "/avatars/npc/priestess.png",
  ]);
  assert.deepEqual(resolveAssetCandidatesLocal("portrait", "普瑞赛斯", null), [
    "/avatars/npc/priestess.png",
  ]);
  assert.deepEqual(resolveAssetCandidatesLocal("avatar", "希尔达", null), [
    "/avatars/npc/hierda.png",
  ]);
  // 即使 index 里恰好有同名条目，覆盖表仍然优先。
  const index = { nameToCharId: { 普瑞赛斯: "char_999_fake" }, charIdToName: {} };
  assert.deepEqual(resolveAssetCandidatesLocal("avatar", "普瑞赛斯", index), [
    "/avatars/npc/priestess.png",
  ]);
});

test("portrait：精二（_2）候选排在精一（_1 / _1b）之前", () => {
  assert.deepEqual(resolveAssetCandidatesLocal("portrait", "char_002_amiya", null), [
    `${YUANYAN}/portrait/char_002_amiya_2.png`,
    `${FEXLI}/charpack/char_002_amiya_2.png`,
    `${PUPPIIZ}/characters/char_002_amiya_2.png`,
    `${YUANYAN}/portrait/char_002_amiya_1.png`,
    `${YUANYAN}/portrait/char_002_amiya_1b.png`,
    `${FEXLI}/charpack/char_002_amiya_1.png`,
    `${PUPPIIZ}/characters/char_002_amiya_1.png`,
  ]);
});

test("image：$ 前缀剥掉且只剥一次", () => {
  assert.deepEqual(resolveAssetCandidatesLocal("image", "$avg_4_1", null), [
    `${FEXLI}/avgs/avg_4_1.png`,
    `${FEXLI}/avgs/bg/avg_4_1.png`,
    `${PUPPIIZ}/storyline/images/avg_4_1.png`,
  ]);
  // 无 $ 前缀的 token 产出相同候选。
  assert.deepEqual(
    resolveAssetCandidatesLocal("image", "avg_4_1", null),
    resolveAssetCandidatesLocal("image", "$avg_4_1", null)
  );
  // 双 $ 只剥掉开头一个。
  const doubled = resolveAssetCandidatesLocal("image", "$$avg", null);
  assert.equal(doubled[0], `${FEXLI}/avgs/$avg.png`);
});

test("background：bg 子目录优先，$ 前缀同样只剥一次", () => {
  assert.deepEqual(resolveAssetCandidatesLocal("background", "$bg_courtyard", null), [
    `${FEXLI}/avgs/bg/bg_courtyard.png`,
    `${FEXLI}/avgs/bg_courtyard.png`,
    `${PUPPIIZ}/storyline/backgrounds/bg_courtyard.png`,
  ]);
  const doubled = resolveAssetCandidatesLocal("background", "$$bg_x", null);
  assert.equal(doubled[0], `${FEXLI}/avgs/bg/$bg_x.png`);
});

test("chapter_cover：个位数章节号补零到两位，原始编号保留在 avgs 兜底里", () => {
  assert.deepEqual(resolveAssetCandidatesLocal("chapter_cover", "main_8", null), [
    "/bundled/mapreview/main_08-01.png",
    `${FEXLI}/mapreview/main_08-01.png`,
    `${FEXLI}/avgs/bg_main_8.png`,
    `${FEXLI}/avgs/8_i01.png`,
    `${FEXLI}/avgs/8_I01.png`,
  ]);
  // 两位数不再补零。
  const c13 = resolveAssetCandidatesLocal("chapter_cover", "main_13", null);
  assert.equal(c13[0], "/bundled/mapreview/main_13-01.png");
});

test("activity_kv：原始 token 永远排最前，图片扩展名被剥掉，无重复", () => {
  assert.deepEqual(
    resolveAssetCandidatesLocal("activity_kv", "act17side_entrypic.png", null),
    [
      `${FEXLI}/kvimg/act17side_entrypic.png`,
      `${FEXLI}/kvimg/default_kv_act17side_entrypic.png`,
      `${FEXLI}/kvimg/kv_act17side_entrypic.png`,
      `${FEXLI}/kvimg/default_kv_side_entrypic.png`,
      `${FEXLI}/kvimg/kv_side_entrypic1.png`,
      `${FEXLI}/kvimg/kv_side_entrypic.png`,
    ]
  );
  // 剥前缀后削成空串时只保留原始 token 的三条。
  assert.deepEqual(resolveAssetCandidatesLocal("activity_kv", "act17side", null), [
    `${FEXLI}/kvimg/act17side.png`,
    `${FEXLI}/kvimg/default_kv_act17side.png`,
    `${FEXLI}/kvimg/kv_act17side.png`,
  ]);
  const kv = resolveAssetCandidatesLocal("activity_kv", "act1sandbox", null);
  assert.equal(new Set(kv).size, kv.length, "候选列表不应有重复");
});

test("activity_logo：brand / camplogo 双路径，附带剥前缀兜底", () => {
  assert.deepEqual(resolveAssetCandidatesLocal("activity_logo", "act1sandbox", null), [
    `${FEXLI}/kvimg/brand_act1sandbox.png`,
    `${FEXLI}/camplogo/logo_act1sandbox.png`,
    `${FEXLI}/kvimg/brand_sandbox.png`,
    `${FEXLI}/camplogo/logo_sandbox.png`,
  ]);
});

test("stripActPrefix 削空：mini 后缀与纯数字活动号都不产生 core 兜底", () => {
  // `act13mini` → 剥 act → 剥数字 → 剩 "mini" → 剥 mini 后缀 → 空串。
  assert.deepEqual(resolveAssetCandidatesLocal("activity_kv", "act13mini", null), [
    `${FEXLI}/kvimg/act13mini.png`,
    `${FEXLI}/kvimg/default_kv_act13mini.png`,
    `${FEXLI}/kvimg/kv_act13mini.png`,
  ]);
  assert.deepEqual(resolveAssetCandidatesLocal("activity_logo", "act13mini", null), [
    `${FEXLI}/kvimg/brand_act13mini.png`,
    `${FEXLI}/camplogo/logo_act13mini.png`,
  ]);
  // `act17` → 剥 act → 剥数字 → 空串。
  assert.deepEqual(resolveAssetCandidatesLocal("activity_kv", "act17", null), [
    `${FEXLI}/kvimg/act17.png`,
    `${FEXLI}/kvimg/default_kv_act17.png`,
    `${FEXLI}/kvimg/kv_act17.png`,
  ]);
});

test("stripActPrefix：act_ 下划线前缀走 4 位剥除，削空时同样只留原始候选", () => {
  // `act_10side` → 剥 "act_" → 剥数字 → 剩 "side" → 剥 side 后缀 → 空串。
  assert.deepEqual(resolveAssetCandidatesLocal("activity_kv", "act_10side", null), [
    `${FEXLI}/kvimg/act_10side.png`,
    `${FEXLI}/kvimg/default_kv_act_10side.png`,
    `${FEXLI}/kvimg/kv_act_10side.png`,
  ]);
  // 剥完仍有内容时照常追加 core 兜底。
  assert.deepEqual(resolveAssetCandidatesLocal("activity_logo", "act_fun2024", null), [
    `${FEXLI}/kvimg/brand_act_fun2024.png`,
    `${FEXLI}/camplogo/logo_act_fun2024.png`,
    `${FEXLI}/kvimg/brand_fun2024.png`,
    `${FEXLI}/camplogo/logo_fun2024.png`,
  ]);
});

test("非 act 开头但带数字前缀的活动 id（如 1stact）：数字剥除无条件生效", () => {
  // `replace(/^\d+/)` 不以 act 前缀为前提：`1stact` → `stact`，core 兜底
  // 跟在原始候选后面。这是既有启发式的真实形态（多两条 404 兜底，原始
  // token 仍然最优先），钉住它防止误改。
  assert.deepEqual(resolveAssetCandidatesLocal("activity_kv", "1stact", null), [
    `${FEXLI}/kvimg/1stact.png`,
    `${FEXLI}/kvimg/default_kv_1stact.png`,
    `${FEXLI}/kvimg/kv_1stact.png`,
    `${FEXLI}/kvimg/default_kv_stact.png`,
    `${FEXLI}/kvimg/kv_stact1.png`,
    `${FEXLI}/kvimg/kv_stact.png`,
  ]);
  // 完全不含可剥内容的 token（无 act 前缀、无数字、无 side/mini 后缀）
  // 才是「猜不出 core」，只出原始候选。
  assert.deepEqual(resolveAssetCandidatesLocal("activity_logo", "storyMainPic", null), [
    `${FEXLI}/kvimg/brand_storyMainPic.png`,
    `${FEXLI}/camplogo/logo_storyMainPic.png`,
  ]);
});

test("activity_kv / activity_logo：jpg/jpeg/webp 扩展名大小写不敏感地剥掉", () => {
  const fromJpg = resolveAssetCandidatesLocal("activity_kv", "act17side_entrypic.JPG", null);
  assert.deepEqual(
    fromJpg,
    resolveAssetCandidatesLocal("activity_kv", "act17side_entrypic.png", null)
  );
  assert.equal(fromJpg[0], `${FEXLI}/kvimg/act17side_entrypic.png`);
  assert.deepEqual(
    resolveAssetCandidatesLocal("activity_kv", "act17side_entrypic.jpeg", null),
    fromJpg
  );
  assert.deepEqual(resolveAssetCandidatesLocal("activity_logo", "act10side_logo.webp", null), [
    `${FEXLI}/kvimg/brand_act10side_logo.png`,
    `${FEXLI}/camplogo/logo_act10side_logo.png`,
    `${FEXLI}/kvimg/brand_side_logo.png`,
    `${FEXLI}/camplogo/logo_side_logo.png`,
  ]);
});

test("portrait：中文名经 index 解析，与直接传 charId 产出相同候选", () => {
  const index = { nameToCharId: { 阿米娅: "char_002_amiya" }, charIdToName: {} };
  assert.deepEqual(
    resolveAssetCandidatesLocal("portrait", "阿米娅", index),
    resolveAssetCandidatesLocal("portrait", "char_002_amiya", null)
  );
});

test("NPC 覆盖表：token 两侧空白剥掉后仍命中", () => {
  assert.deepEqual(resolveAssetCandidatesLocal("avatar", "  普瑞赛斯  ", null), [
    "/avatars/npc/priestess.png",
  ]);
  assert.deepEqual(resolveAssetCandidatesLocal("portrait", " 希尔达 ", null), [
    "/avatars/npc/hierda.png",
  ]);
});

test("空白 token 与未知 kind 都返回空数组", () => {
  assert.deepEqual(resolveAssetCandidatesLocal("avatar", "   ", null), []);
  assert.deepEqual(resolveAssetCandidatesLocal("image", "", null), []);
  assert.deepEqual(resolveAssetCandidatesLocal("nope", "x", null), []);
  // 非 char_ token 且没有 index 时无从解析。
  assert.deepEqual(resolveAssetCandidatesLocal("avatar", "unknown_person", null), []);
});

// ─────────────────────────────────────────────────────────────
// 兜底渐变
// ─────────────────────────────────────────────────────────────

test("hashHue 确定且落在 [0, 360)，gradientFallbackBackground 稳定", () => {
  assert.equal(hashHue("char_002_amiya"), 87);
  assert.equal(hashHue(""), 0);
  assert.equal(hashHue("seed"), hashHue("seed"));
  for (const s of ["a", "字", "char_1001_amiya2#2"]) {
    const hue = hashHue(s);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360);
  }
  // 空 seed 回落到 "ark"。
  assert.equal(gradientFallbackBackground(""), gradientFallbackBackground("ark"));
  assert.equal(
    gradientFallbackBackground("ark"),
    "linear-gradient(135deg, hsl(18 26% 46% / 0.32), hsl(58 32% 36% / 0.28))"
  );
});

// ─────────────────────────────────────────────────────────────
// 失败记录与 host 熔断
// ─────────────────────────────────────────────────────────────

test("单条 URL 失败只记那一条账，不连坐同 host 其他 URL", () => {
  const dead = "https://mirror-a.invalid/a.png";
  const fresh = "https://mirror-a.invalid/b.png";
  assert.equal(isAssetUrlDead(dead), false);
  markAssetUrlDead(dead);
  assert.equal(isAssetUrlDead(dead), true);
  assert.equal(isAssetUrlDead(fresh), false);

  assert.deepEqual(pickLiveCandidate([dead, fresh]), { url: fresh, index: 1 });
  assert.equal(pickLiveCandidate([dead]), null);
  assert.equal(pickLiveCandidate([]), null);
  assert.deepEqual(pickLiveCandidate([fresh, dead], 1), null);

  // URL 本身失败（而非 host 熔断）不算可恢复。
  assert.equal(hasRecoverableCandidate([dead]), false);

  // 相对路径（本地素材）没有 host，永不熔断。
  markAssetUrlDead("/bundled/avatar/x.png");
  assert.equal(isAssetUrlDead("/bundled/avatar/x.png"), true);
  assert.equal(isAssetUrlDead("/bundled/avatar/y.png"), false);
});

test("markAssetUrlAlive：host 一旦证明可达就永久免疫熔断", () => {
  const host = "https://mirror-b.invalid";
  const before = getAssetHealthVersion();
  markAssetUrlAlive(`${host}/ok.png`);
  assert.equal(getAssetHealthVersion(), before + 1, "首次证明可达应广播健康事件");
  markAssetUrlAlive(`${host}/ok2.png`);
  assert.equal(getAssetHealthVersion(), before + 1, "重复标记不再广播");

  for (let i = 0; i < 10; i += 1) markAssetUrlDead(`${host}/miss-${i}.png`);
  // 单条 URL 仍然记账，但 host 不会被熔断。
  assert.equal(isAssetUrlDead(`${host}/miss-0.png`), true);
  assert.equal(isAssetUrlDead(`${host}/fresh.png`), false);
});

test("host 首次证明可达时撤销此前的 URL 级失败；之后的失败才永久记账", () => {
  const host = "https://mirror-f.invalid";
  // proven 之前的失败：可能是断网/被墙，判决不可靠。
  markAssetUrlDead(`${host}/suspect.png`);
  markAssetUrlDead("https://mirror-g.invalid/other.png");
  assert.equal(isAssetUrlDead(`${host}/suspect.png`), true);

  markAssetUrlAlive(`${host}/proof.png`);
  assert.equal(isAssetUrlDead(`${host}/suspect.png`), false, "存疑失败应被撤销、允许重试");
  // 其他 host 的记录不连坐。
  assert.equal(isAssetUrlDead("https://mirror-g.invalid/other.png"), true);

  // proven 之后的失败是真 404，永久记账；重复 markAlive 也不再撤销。
  markAssetUrlDead(`${host}/really-missing.png`);
  markAssetUrlAlive(`${host}/proof2.png`);
  assert.equal(isAssetUrlDead(`${host}/really-missing.png`), true);
});

test("host 熔断：达到阈值后整 host 拒答，到期自动唤醒订阅者，退避翻倍", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const host = "https://mirror-c.invalid";
  const fresh = `${host}/fresh.png`;
  let notices = 0;
  const unsub = subscribeAssetHealth(() => {
    notices += 1;
  });

  for (let i = 0; i < 7; i += 1) markAssetUrlDead(`${host}/f${i}.png`);
  assert.equal(isAssetUrlDead(fresh), false, "7 次失败还差一次，不该熔断");

  markAssetUrlDead(`${host}/f7.png`);
  assert.equal(isAssetUrlDead(fresh), true, "第 8 次失败触发 host 熔断");
  // fresh 本身没失败过，只是 host 在熔断窗口内 —— 可恢复。
  assert.equal(hasRecoverableCandidate([fresh]), true);
  assert.equal(pickLiveCandidate([fresh]), null);

  const v0 = getAssetHealthVersion();
  // 首次熔断 30s，唤醒定时器带 50ms 余量。
  t.mock.timers.tick(30_000 + 51);
  assert.equal(notices, 1, "熔断到期应广播一次健康事件");
  assert.equal(getAssetHealthVersion(), v0 + 1);
  assert.equal(isAssetUrlDead(fresh), false, "熔断到期后 host 解封");

  // 二次熔断按指数退避翻倍到 60s。
  for (let i = 8; i < 16; i += 1) markAssetUrlDead(`${host}/f${i}.png`);
  assert.equal(isAssetUrlDead(fresh), true);
  t.mock.timers.tick(30_000 + 51);
  assert.equal(isAssetUrlDead(fresh), true, "退避翻倍后 30s 时仍在熔断");
  assert.equal(notices, 1, "还没到期不该提前唤醒");
  t.mock.timers.tick(30_000);
  assert.equal(isAssetUrlDead(fresh), false);
  assert.equal(notices, 2, "第二次到期再广播一次");

  unsub();
  // 退订后其他健康事件不再打进来。
  markAssetUrlAlive("https://mirror-d.invalid/ok.png");
  assert.equal(notices, 2);
});

test("失败计数窗口：超过 15s 的旧账不参与熔断判定", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const host = "https://mirror-e.invalid";
  for (let i = 0; i < 7; i += 1) markAssetUrlDead(`${host}/f${i}.png`);
  t.mock.timers.tick(16_000);
  markAssetUrlDead(`${host}/f7.png`);
  assert.equal(
    isAssetUrlDead(`${host}/fresh.png`),
    false,
    "窗口外的 7 次旧失败被清零，第 8 次不该触发熔断"
  );
});
