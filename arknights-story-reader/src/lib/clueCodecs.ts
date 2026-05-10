// Clue set share code encoder/decoder.
// Format AKC1-<base64url(deflate(binary))>
// Binary layout (little-endian where applicable):
// [version: u8=1]
// [stories_count: varint]
//   repeat stories_count times: [story_len: varint][story_id: utf8 bytes]
// [items_count: varint]
//   repeat items_count times: [story_index: varint][segment_index: varint][digest64: u64]
// No title in payload to keep deterministic identity by content only.

export interface EncodedClueItemRef {
  storyIndex: number;
  segmentIndex: number;
  digest64: bigint; // 64-bit digest (FNV-1a 64)
}

export interface EncodedCluePayloadV1 {
  version: 1;
  stories: string[];
  items: EncodedClueItemRef[];
}

// Utilities: varint, base64url, (de)compression, hashing, normalization

function encodeVarint(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error("varint expects non-negative int");
  const bytes: number[] = [];
  let value = n >>> 0;
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return new Uint8Array(bytes);
}

function decodeVarint(view: DataView, offset: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    if (pos >= view.byteLength) throw new Error("Unexpected EOF while decoding varint");
    const b = view.getUint8(pos++);
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error("varint too large");
  }
  return { value: result >>> 0, next: pos };
}

function textEncode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function textDecode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function putU64LE(x: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = x & 0xffffffffffffffffn;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function getU64LE(view: DataView, offset: number): { value: bigint; next: number } {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v |= BigInt(view.getUint8(offset + i)) << BigInt(8 * i);
  }
  return { value: v, next: offset + 8 };
}

// base64url helpers
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as any);
  }
  const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return b64;
}

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  // @ts-ignore
  if (typeof DecompressionStream === "function") {
    try {
      // @ts-ignore
      const ds = new DecompressionStream("deflate");
      const writer = (ds.writable as WritableStream<Uint8Array>).getWriter();
      await writer.write(bytes);
      await writer.close();
      const res = await new Response((ds.readable as ReadableStream<Uint8Array>)).arrayBuffer();
      return new Uint8Array(res);
    } catch {
      // ignore and fallback
    }
  }
  return bytes; // if can't inflate assume raw
}

// Normalization and digest (FNV-1a 64)
export function normalizeForDigest(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function fnv1a64(input: string): bigint {
  const data = textEncode(input);
  let hash = 0xcbf29ce484222325n; // FNV offset basis
  const prime = 0x100000001b3n; // FNV prime
  for (let i = 0; i < data.length; i++) {
    hash ^= BigInt(data[i]);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
}

// Encode payload to bytes
export function encodePayloadV1(payload: EncodedCluePayloadV1): Uint8Array {
  const chunks: Uint8Array[] = [];
  chunks.push(new Uint8Array([1])); // version
  // stories
  chunks.push(encodeVarint(payload.stories.length));
  for (const s of payload.stories) {
    const b = textEncode(s);
    chunks.push(encodeVarint(b.length));
    chunks.push(b);
  }
  // items
  chunks.push(encodeVarint(payload.items.length));
  for (const it of payload.items) {
    chunks.push(encodeVarint(it.storyIndex));
    chunks.push(encodeVarint(it.segmentIndex));
    chunks.push(putU64LE(it.digest64));
  }
  return concatBytes(chunks);
}

export function decodePayloadV1(bytes: Uint8Array): EncodedCluePayloadV1 {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const ver = view.getUint8(pos++);
  if (ver !== 1) throw new Error(`Unsupported version: ${ver}`);
  let r = decodeVarint(view, pos);
  const storiesCount = r.value; pos = r.next;
  const stories: string[] = [];
  for (let i = 0; i < storiesCount; i++) {
    r = decodeVarint(view, pos);
    const len = r.value; pos = r.next;
    if (pos + len > view.byteLength) throw new Error("Invalid string length");
    const str = textDecode(new Uint8Array(bytes.buffer, bytes.byteOffset + pos, len));
    stories.push(str);
    pos += len;
  }
  r = decodeVarint(view, pos);
  const itemsCount = r.value; pos = r.next;
  const items: EncodedClueItemRef[] = [];
  for (let i = 0; i < itemsCount; i++) {
    r = decodeVarint(view, pos); const storyIndex = r.value; pos = r.next;
    r = decodeVarint(view, pos); const segmentIndex = r.value; pos = r.next;
    const d = getU64LE(view, pos); pos = d.next;
    items.push({ storyIndex, segmentIndex, digest64: d.value });
  }
  return { version: 1, stories, items };
}

export interface ClueSetShareCodeInfo {
  payload: EncodedCluePayloadV1;
  binary: Uint8Array;
  compressed: Uint8Array;
  code: string;
}

export async function buildShareCode(payload: EncodedCluePayloadV1): Promise<ClueSetShareCodeInfo> {
  const binary = encodePayloadV1(payload);
  // 为最大兼容性，默认不压缩；保留 compressed 字段为 binary 以兼容调用方。
  const compressed = binary;
  const code = `AKC1-${base64urlEncode(binary)}`;
  return { payload, binary, compressed, code };
}

export async function parseShareCode(code: string): Promise<EncodedCluePayloadV1> {
  if (!code || typeof code !== "string") throw new Error("Empty code");
  const m = code.trim().match(/^AKC1-([A-Za-z0-9_-]+)$/);
  const raw = m ? m[1] : code; // allow raw payload for debugging
  const bytes = base64urlDecode(raw);
  // try direct decode (uncompressed)
  try {
    return decodePayloadV1(bytes);
  } catch {
    // try inflate then decode
    const inflated = await inflate(bytes);
    return decodePayloadV1(inflated);
  }
}

// Helpers for hex digest conversions
export function digestToHex64(d: bigint): string {
  return d.toString(16).padStart(16, "0");
}

export function hexToDigest64(hex: string): bigint {
  const clean = hex.replace(/[^0-9a-f]/gi, "").padStart(16, "0");
  return BigInt(`0x${clean}`);
}
