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

// FNV-1a 64 bit constants
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/**
 * 复用同一个 encoder。一篇长剧情要算上千次摘要，每次都 `new TextEncoder()`
 * 是纯粹的分配开销。
 */
const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

/** 64-bit FNV-1a 哈希。返回 `bigint`，便于使用统一的十六进制输出。 */
export function fnv1a64(text: string): bigint {
  let hash = FNV_OFFSET;
  // 用 TextEncoder 确保同一字符串在任何环境下产出相同字节。
  const bytes = encoder ? encoder.encode(text) : null;
  if (bytes) {
    for (let i = 0; i < bytes.length; i += 1) {
      hash ^= BigInt(bytes[i]);
      hash = (hash * FNV_PRIME) & MASK;
    }
    return hash;
  }
  // 没有 TextEncoder 的环境（老 WebView）退化成按 UTF-16 码元计算：
  // 结果与上面不同，但同一环境内保持自洽，摘要只用于本机对齐。
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash;
}

/** 把 64 位摘要格式化成固定 16 位十六进制字符串（小写、零填充）。 */
export function digestToHex64(value: bigint): string {
  return value.toString(16).padStart(16, "0");
}

/**
 * 摘要缓存。同一篇剧情在阅读器里会反复卸载/重挂（返回列表再进来、换阅读
 * 模式），缓存能把整篇的重复计算省掉；满了淘汰最久未使用的条目（LRU），
 * 避免无限增长。
 */
const DIGEST_CACHE_LIMIT = 4096;
const digestCache = new Map<string, string>();

/** 便捷封装：对文本做规范化 + 计算摘要 + 十六进制输出。 */
export function segmentDigest(text: string): string {
  const cached = digestCache.get(text);
  if (cached !== undefined) {
    // 命中即重插（LRU touch）：让常用条目排到淘汰队尾，反复进出同一篇
    // 长剧情时不会被后来者按插入顺序挤掉。
    digestCache.delete(text);
    digestCache.set(text, cached);
    return cached;
  }
  const digest = digestToHex64(fnv1a64(normalizeForDigest(text)));
  if (digestCache.size >= DIGEST_CACHE_LIMIT) {
    const oldest = digestCache.keys().next();
    if (!oldest.done) digestCache.delete(oldest.value);
  }
  digestCache.set(text, digest);
  return digest;
}
