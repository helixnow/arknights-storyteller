# 明日方舟剧情阅读器 1.12.0 发布说明（待发布）

> 本文件用于下一轮正式发版。本轮仅完成可发布准备，尚未创建 tag 或 GitHub Release。

## 本轮改造

- 完善阅读器、剧情列表、首页与移动端应用外壳，强化阅读流程和移动端交互。
- 加固 Rust 数据处理、剧情解析与搜索链路，并补充相关回归测试。
- 完善全文搜索、人物素材、分享图、设置同步与应用更新能力。
- 将应用版本统一升级至 `1.12.0`，覆盖 npm、Tauri 与 Cargo 的清单及锁文件。

## 发布工程改进

- Android 构建环境固定安装 API 36 平台和 Build Tools 36.0.0，与工程的 `compileSdk = 36` 保持一致。
- 正式发布必须使用有效的 release keystore；密钥缺失、口令错误或 alias 无效时立即失败，不再回退到 debug keystore。
- 发布工作流直接使用仓库已提交的版本，并校验五处版本号一致，不再自动 bump 或向 `release` 分支回推提交。
- 创建 Release 时显式绑定当前提交 SHA；若目标 Release 或 tag 已存在则终止，避免覆盖历史发布。
- `Cargo.lock` 已随 `Cargo.toml` 的版本更新一并刷新并纳入发布校验。

## 下一轮发版检查

1. 确认 `app-v1.12.0` tag 和同名 GitHub Release 仍未被占用。
2. 确认 Android 签名所需的四项 GitHub Secrets 均有效。
3. 从待发布提交运行 `release-android` 工作流，核对 APK 签名、`android-latest.json` 和桌面 `latest.json` 搬运结果。
4. 正式发布后验证 latest Release、APK 下载链接和客户端更新检查。
