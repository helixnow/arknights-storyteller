/**
 * 段落内容摘要（FNV-1a 64 位）工具。
 *
 * 这些函数原本在 `lib/clueCodecs.ts` 里，用于生成线索集分享码。线索集功能
 * 已移除，但段落摘要仍然有价值：它给每条划线 / 每个跳转目标提供一个与数据
 * 版本无关的内容指纹，以便在剧情数据更新后段号发生偏移时，按摘要回对齐
 * 到正确的段落。
 */

/**
 * NFKC + lowercase + 剥离所有 Unicode 标点/符号/空白，得到一份跨数据版本
 * 尽可能稳定的指纹底稿。注意：做过细的改造反而会让同一段落因小变化而指纹
 * 不匹配，所以这里只做最必要的规范化。
 */
export function normalizeForDigest(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

/** 64-bit FNV-1a 哈希。返回 `bigint`，便于使用统一的十六进制输出。 */
export function fnv1a64(text: string): bigint {
  // FNV-1a 64 bit constants
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  // 用 TextEncoder 确保同一字符串在任何环境下产出相同字节。
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash;
}

/** 把 64 位摘要格式化成固定 16 位十六进制字符串（小写、零填充）。 */
export function digestToHex64(value: bigint): string {
  return value.toString(16).padStart(16, "0");
}

/** 便捷封装：对文本做规范化 + 计算摘要 + 十六进制输出。 */
export function segmentDigest(text: string): string {
  return digestToHex64(fnv1a64(normalizeForDigest(text)));
}
