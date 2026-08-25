import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyAndroidInstallResponse,
  compareVersions,
  describeUpdateError,
  normalizeAndroidDownloadProgress,
  isAllowedAndroidDownloadProtocol,
  parseAndroidManifest,
  validateAndroidFeedUrl,
} from "./appUpdaterUtils.ts";

test("正式版本高于同号预发布版本", () => {
  assert.equal(compareVersions("1.2.3", "1.2.3-beta.9"), 1);
  assert.equal(compareVersions("1.2.3-beta.9", "1.2.3"), -1);
});

test("预发布数字标识按数值排序", () => {
  assert.equal(compareVersions("1.2.3-beta.10", "1.2.3-beta.2"), 1);
});

test("版本前缀和构建元数据不影响比较", () => {
  assert.equal(compareVersions("v1.2.3+android", "1.2.3+desktop"), 0);
});

test("缺失的核心段按零处理", () => {
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.2.1", "1.2"), 1);
});

test("签名错误保持安全级别红色", () => {
  const issue = describeUpdateError("public key signature verification failed");
  assert.deepEqual(issue, {
    tone: "error",
    kind: "signature",
    message: "更新包签名校验失败，出于安全考虑已中止安装。",
  });
});

test("包含 manifest 字样的网络错误仍归类网络", () => {
  assert.equal(describeUpdateError("failed to fetch manifest: network offline").kind, "network");
});

test("HTTP 更新源错误归类 feed", () => {
  assert.equal(describeUpdateError("android-latest.json HTTP 404").kind, "feed");
});

test("取消安装不是故障", () => {
  assert.equal(describeUpdateError("The operation was cancelled by the user").kind, "cancelled");
});

test("并发 APK 下载给出忙碌提示", () => {
  const issue = describeUpdateError("已有更新下载正在进行，请等待完成后再试");
  assert.equal(issue.kind, "busy");
  assert.equal(issue.tone, "warning");
});

test("Android 原生插件未初始化归类配置问题", () => {
  assert.equal(describeUpdateError("更新组件未初始化（原生插件注册失败）").kind, "not-configured");
});

test("Tauri 普通错误对象不会变成 object Object", () => {
  assert.equal(describeUpdateError({ message: "dns error" }).kind, "network");
});

test("未知更新错误透出前脱敏", () => {
  const issue = describeUpdateError("failed at https://private.invalid/app.apk?token=secret");
  assert.equal(issue.kind, "unknown");
  assert.doesNotMatch(issue.message, /private\.invalid|secret/);
});

test("Android feed 必须明确指向 android-latest.json", () => {
  assert.equal(
    validateAndroidFeedUrl(
      "https://github.com/helixnow/arknights-storyteller/releases/latest/download/android-latest.json"
    ),
    "https://github.com/helixnow/arknights-storyteller/releases/latest/download/android-latest.json"
  );
});

test("Android 不会误用桌面 latest.json", () => {
  assert.throws(
    () => validateAndroidFeedUrl("https://example.invalid/latest.json"),
    /android-latest\.json/
  );
});

test("Android feed 拒绝非 HTTP 协议", () => {
  assert.throws(() => validateAndroidFeedUrl("file:///tmp/android-latest.json"), /android-latest/);
});

test("Android 下载协议：正式环境只接受 https，调试才放行 http", () => {
  assert.equal(isAllowedAndroidDownloadProtocol("https:"), true);
  assert.equal(isAllowedAndroidDownloadProtocol("http:"), false);
  assert.equal(isAllowedAndroidDownloadProtocol("http:", true), true);
  assert.equal(isAllowedAndroidDownloadProtocol("file:"), false);
});

test("Android manifest 规范化合法字段", () => {
  assert.deepEqual(
    parseAndroidManifest({
      version: " 1.10.53 ",
      url: "https://example.invalid/app.apk",
      fileName: "story-1.10.53.apk",
      notes: "修复",
    }),
    {
      version: "1.10.53",
      url: "https://example.invalid/app.apk",
      fileName: "story-1.10.53.apk",
      notes: "修复",
    }
  );
});

test("Android manifest 缺字段会失败而非报告已是最新", () => {
  assert.throws(() => parseAndroidManifest({ version: "1.2.3" }), /缺少 version 或 url/);
});

test("Android manifest 拒绝危险文件名", () => {
  assert.throws(
    () =>
      parseAndroidManifest({
        version: "1.2.3",
        url: "https://example.invalid/app.apk",
        fileName: "../app.apk",
      }),
    /文件名无效/
  );
});

test("Android manifest 拒绝非网络下载地址", () => {
  assert.throws(
    () => parseAndroidManifest({ version: "1.2.3", url: "file:///sdcard/app.apk" }),
    /https|下载地址/
  );
});


test("Android 安装只接受权限需求或已拉起安装器", () => {
  assert.equal(classifyAndroidInstallResponse({ needsPermission: true }), "needs-permission");
  assert.equal(
    classifyAndroidInstallResponse({ status: "install-intent-launched" }),
    "installer-launched"
  );
});

test("空或未知 Android 安装结果不会被当成成功", () => {
  assert.throws(() => classifyAndroidInstallResponse({}), /无法识别/);
  assert.throws(() => classifyAndroidInstallResponse(undefined), /未返回安装结果/);
});

test("Android 下载进度支持确定与不确定总量", () => {
  assert.deepEqual(normalizeAndroidDownloadProgress({ current: 25, total: 100, message: "下载中" }), {
    downloadedBytes: 25,
    totalBytes: 100,
    percent: 25,
    done: false,
  });
  assert.deepEqual(normalizeAndroidDownloadProgress({ current: 25, total: -1, message: "下载中" }), {
    downloadedBytes: 25,
    totalBytes: null,
    percent: null,
    done: false,
  });
});

test("Android 下载完成事件标记准备安装", () => {
  assert.equal(
    normalizeAndroidDownloadProgress({ current: 100, total: 100, message: "下载完成" })?.done,
    true
  );
  assert.equal(normalizeAndroidDownloadProgress({ current: -1, total: 100 }), null);
});

test("Android 下载进度使用 Plugin.trigger 对应的插件监听通道", () => {
  const source = readFileSync(new URL("./useAppUpdater.ts", import.meta.url), "utf8");
  assert.match(source, /addPluginListener<unknown>\(\s*"apk-updater",\s*"apk-progress"/);
  assert.match(source, /await progressListener\.unregister\(\)/);
  assert.doesNotMatch(source, /listen<unknown>\("apk-progress"/);
});

test("@tauri-apps/api 2.11 插件监听命令均在 Android ACL 白名单", () => {
  const source = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(source, /plugin:apk-updater\|register_listener/);
  assert.match(source, /plugin:apk-updater\|registerListener/);
  assert.match(source, /plugin:apk-updater\|remove_listener/);
});
