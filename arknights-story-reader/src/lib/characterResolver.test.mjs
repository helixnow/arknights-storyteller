import { test } from "node:test";
import assert from "node:assert/strict";

import {
  characterAvatarIdentityKey,
  createCharacterResolver,
  resolveAssetCandidatesLocal,
  resolveCharacterIdLocal,
} from "./assetUrls.ts";

function indexOf({ names = {}, ids = {} } = {}) {
  return { nameToCharId: names, charIdToName: ids };
}

test("direct charId is case-insensitive and strips skin suffix without an index", () => {
  assert.equal(resolveCharacterIdLocal("CHAR_002_AMIYA#2", null), "char_002_amiya");
  assert.equal(resolveCharacterIdLocal("  Char_124_Kroos  ", null), "char_124_kroos");
});

test("case-insensitive memory charId produces the canonical avatar chain", () => {
  assert.deepEqual(
    resolveAssetCandidatesLocal("avatar", "CHAR_002_AMIYA#1", null),
    resolveAssetCandidatesLocal("avatar", "char_002_amiya", null)
  );
});

test("resolver handles exact display names and reverse name lookup", () => {
  const resolver = createCharacterResolver(
    indexOf({
      names: { 阿米娅: "char_002_amiya" },
      ids: { char_002_amiya: "阿米娅" },
    })
  );
  assert.equal(resolver.hasIndex, true);
  assert.equal(resolver.resolveCharId("阿米娅"), "char_002_amiya");
  assert.equal(resolver.resolveName("char_002_amiya"), "阿米娅");
});

test("resolver normalizes spaces and middle-dot variants in display names", () => {
  const resolver = createCharacterResolver(
    indexOf({
      names: { "玛恩纳·临光": "char_4064_mlynar" },
      ids: { char_4064_mlynar: "玛恩纳·临光" },
    })
  );
  for (const name of ["玛恩纳临光", " 玛恩纳 ‧ 临光 ", "玛恩纳・临光"]) {
    assert.equal(resolver.resolveCharId(name), "char_4064_mlynar");
  }
});

test("Latin display names and memory aliases resolve case-insensitively", () => {
  const resolver = createCharacterResolver(
    indexOf({
      names: { "Amiya Guard": "char_1001_amiya2" },
      ids: {
        char_1001_amiya2: "阿米娅（近卫）",
        char_124_kroos: "克洛丝",
      },
    })
  );
  assert.equal(resolver.resolveCharId("amiya guard"), "char_1001_amiya2");
  assert.equal(resolver.resolveCharId("KROOS"), "char_124_kroos");
});

test("reverse lookup accepts uppercase charId and skin suffix", () => {
  const resolver = createCharacterResolver(
    indexOf({ ids: { char_010_chen: "陈" } })
  );
  assert.equal(resolver.resolveName("CHAR_010_CHEN#summer"), "陈");
});

test("name-map charIds are normalized before becoming asset tokens", () => {
  const resolver = createCharacterResolver(
    indexOf({
      names: { 陈: "CHAR_010_CHEN#2" },
      ids: { char_010_chen: "陈" },
    })
  );
  assert.equal(resolver.resolveCharId("陈"), "char_010_chen");
});

test("explicit own keys resolve, inherited prototype keys never do", () => {
  const empty = createCharacterResolver(indexOf());
  assert.equal(empty.resolveCharId("constructor"), null);
  assert.equal(empty.resolveCharId("toString"), null);

  const names = Object.create(null);
  names.constructor = "char_999_ctor";
  const explicit = createCharacterResolver(indexOf({ names }));
  assert.equal(explicit.resolveCharId("constructor"), "char_999_ctor");
});

test("duplicate aliases deterministically keep the first index entry", () => {
  const resolver = createCharacterResolver(
    indexOf({
      ids: {
        char_001_same: "甲",
        char_002_same: "乙",
      },
    })
  );
  assert.equal(resolver.resolveCharId("same"), "char_001_same");
});

test("empty and non-character tokens do not invent ids or names", () => {
  const resolver = createCharacterResolver(indexOf({ ids: { char_1_a: "甲" } }));
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(resolver.resolveCharId(value), null);
    assert.equal(resolver.resolveName(value), null);
  }
  assert.equal(resolver.resolveCharId("not-a-character"), null);
  assert.equal(resolver.resolveName("not-a-character"), null);
});

test("hasIndex is true when either side of the index is populated", () => {
  assert.equal(createCharacterResolver(indexOf()).hasIndex, false);
  assert.equal(
    createCharacterResolver(indexOf({ names: { 甲: "char_1_a" } })).hasIndex,
    true
  );
  assert.equal(
    createCharacterResolver(indexOf({ ids: { char_1_a: "甲" } })).hasIndex,
    true
  );
});

test("one index snapshot is memoized while a replacement builds a clean overlay", () => {
  const oldIndex = indexOf({
    names: { 旧名: "char_1_old" },
    ids: { char_1_old: "旧名" },
  });
  const oldA = createCharacterResolver(oldIndex);
  const oldB = createCharacterResolver(oldIndex);
  assert.equal(oldA, oldB);

  const replacement = createCharacterResolver(
    indexOf({
      names: { 新名: "char_2_new" },
      ids: { char_2_new: "新名" },
    })
  );
  assert.notEqual(replacement, oldA);
  assert.equal(replacement.resolveCharId("旧名"), null);
  assert.equal(replacement.resolveCharId("新名"), "char_2_new");
});

test("NPC override remains authoritative even if an index contains the same name", () => {
  const index = indexOf({
    names: { 普瑞赛斯: "char_999_wrong" },
    ids: { char_999_wrong: "普瑞赛斯" },
  });
  assert.deepEqual(resolveAssetCandidatesLocal("avatar", "普瑞赛斯", index), [
    "/avatars/npc/priestess.png",
  ]);
});

test("share avatar identity deduplicates display-name and skin variants of one charId", () => {
  const expected = characterAvatarIdentityKey("？？？", "char_002_amiya#1");
  assert.equal(expected, "char:char_002_amiya");
  assert.equal(characterAvatarIdentityKey("阿米娅", "CHAR_002_AMIYA#2"), expected);
  assert.notEqual(
    characterAvatarIdentityKey("近卫阿米娅", "char_1001_amiya2"),
    expected
  );
});

test("share avatar identity keeps NPC names authoritative and unknown aliases name-scoped", () => {
  assert.equal(
    characterAvatarIdentityKey(" 普瑞赛斯 ", "char_002_amiya"),
    characterAvatarIdentityKey("普瑞赛斯", "char_999_wrong")
  );
  assert.notEqual(
    characterAvatarIdentityKey("甲", "unknown_alias"),
    characterAvatarIdentityKey("乙", "unknown_alias")
  );
  assert.equal(
    characterAvatarIdentityKey("玛恩纳·临光", null),
    characterAvatarIdentityKey(" 玛恩纳 ‧ 临光 ", null)
  );
});
