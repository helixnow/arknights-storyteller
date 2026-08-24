#!/usr/bin/env node
/**
 * 前端单元测试入口（node:test，零额外依赖）。
 *
 * 测试文件本身是 .mjs，但被测模块是 .ts，需要 Node 的 type-stripping 才能
 * 直接加载。较新的 Node（22.18+ / 23.6+）默认开启；更早的 22.x 需要显式
 * 传 --experimental-strip-types。这里用 process.features.typescript 探测，
 * 避免把 flag 硬编码进 package.json 后在未来 Node 版本上失效或报错。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = [];
if (!process.features.typescript) args.push("--experimental-strip-types");
args.push(
  "--test",
  path.join("src", "lib", "assetUrls.test.mjs"),
  path.join("src", "lib", "segmentDigest.test.mjs"),
  path.join("src", "lib", "searchTerms.test.mjs")
);

const result = spawnSync(process.execPath, args, {
  cwd: projectRoot,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
