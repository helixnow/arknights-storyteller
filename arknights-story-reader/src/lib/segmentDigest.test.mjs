/**
 * segmentDigest 单元测试（node:test + node:assert，无额外依赖）。
 *
 * 覆盖：normalizeForDigest 的 NFKC/大小写/标点剥离规则、FNV-1a 64 与官方
 * 参考向量一致、十六进制格式化，以及 segmentDigest 跨"标点/空白/全半角"
 * 变体的稳定性。摘要用于剧情数据更新后按内容回对齐段落，所以下面 pin 住的
 * 黄金值一旦变化就意味着所有已存划线会失配——绝不能悄悄改。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeForDigest,
  fnv1a64,
  digestToHex64,
  segmentDigest,
} from "./segmentDigest.ts";

test("normalizeForDigest：NFKC + 小写 + 剥离标点/符号/空白", () => {
  // 全角字母/空格/标点/符号折叠或剥离，带圈数字折叠成 ASCII。
  assert.equal(normalizeForDigest("ＡＢＣ　ｄｅｆ！＄＋ ①"), "abcdef1");
  assert.equal(normalizeForDigest("Doctor42"), "doctor42");
  // 中文标点（，！——「」…）全部属于 \p{P}，剥掉后只剩文字。
  assert.equal(normalizeForDigest("博士，你好！——「引号」…"), "博士你好引号");
  // ASCII 符号（\p{S}）与空白同样剥离。
  assert.equal(normalizeForDigest("a+b=c $100"), "abc100");
  assert.equal(normalizeForDigest(" \t\n\u3000"), "");
  assert.equal(normalizeForDigest(""), "");
});

test("fnv1a64：与官方 FNV-1a 64 位参考向量一致", () => {
  // 参考向量来自 FNV 规范（Landon Curt Noll 的测试集）。
  assert.equal(fnv1a64(""), 0xcbf29ce484222325n);
  assert.equal(fnv1a64("a"), 0xaf63dc4c8601ec8cn);
  assert.equal(fnv1a64("foobar"), 0x85944171f73967e8n);
  assert.equal(typeof fnv1a64("x"), "bigint");
  // 确定性：同一输入两次调用产出同一值。
  assert.equal(fnv1a64("博士你好"), fnv1a64("博士你好"));
  // 按 UTF-8 字节哈希：多字节字符与其他输入可区分。
  assert.notEqual(fnv1a64("博"), fnv1a64("士"));
});

test("digestToHex64：固定 16 位小写十六进制、零填充", () => {
  assert.equal(digestToHex64(0n), "0000000000000000");
  assert.equal(digestToHex64(0xabcdefn), "0000000000abcdef");
  assert.equal(digestToHex64(0xffffffffffffffffn), "ffffffffffffffff");
  assert.equal(digestToHex64(0xcbf29ce484222325n), "cbf29ce484222325");
});

test("segmentDigest：黄金值 pin 住，跨数据版本不能漂移", () => {
  // 这两个值由当前实现计算并固化。若实现变动导致输出变化，
  // 用户已存的划线/跳转目标将全部失配——必须显式评审。
  assert.equal(segmentDigest("博士，你好！"), "7804feb0f797fd2e");
  assert.equal(segmentDigest(""), "cbf29ce484222325");
});

test("segmentDigest：标点/空白/全半角变体归一到同一摘要", () => {
  const variants = ["博士，你好！", "博士你好", "博士　你好。", "博士 你好!", "博士\n你好"];
  const digests = new Set(variants.map(segmentDigest));
  assert.equal(digests.size, 1, "规范化等价的文本应产出同一摘要");
  // 全角/半角经 NFKC 折叠后一致。
  assert.equal(segmentDigest("ＤＯＣＴＯＲ"), segmentDigest("doctor"));
  // 内容不同的段落必须可区分。
  assert.notEqual(segmentDigest("段落一"), segmentDigest("段落二"));
});

test("segmentDigest：等于 normalize + fnv1a64 + hex 的组合，且格式恒定", () => {
  for (const text of ["博士，你好！", "Originium – 源石。", "  混合 Mixed ４２  "]) {
    assert.equal(segmentDigest(text), digestToHex64(fnv1a64(normalizeForDigest(text))));
    assert.match(segmentDigest(text), /^[0-9a-f]{16}$/);
  }
});

test("segmentDigest：缓存命中与 LRU 淘汰都不改变结果", () => {
  const first = "seg-0";
  const d0 = segmentDigest(first);
  // 第二次调用走缓存命中（LRU touch）路径。
  assert.equal(segmentDigest(first), d0);
  // 塞入超过缓存上限（4096）的条目触发淘汰，被淘汰的条目重算后仍一致。
  for (let i = 0; i < 5000; i += 1) segmentDigest(`seg-${i}`);
  assert.equal(segmentDigest(first), d0);
});
