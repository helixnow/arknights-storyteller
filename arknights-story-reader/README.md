# 明日方舟剧情阅读器 (Arknights Story Reader)

一个基于 Tauri 2 + React 19 + TypeScript + Rust 的本地剧情阅读与搜索应用，支持桌面与移动平台，提供舒适的“小说式”阅读体验、全文检索、人物统计、收藏划线与分享图等功能。

> 数据来自社区项目 ArknightsGameData。应用不包含或分发任何商业素材，仅提供本地阅读与管理能力。

## ✨ 功能特性

- 阅读体验与设置
  - 对话/旁白/标题/系统提示等分段渲染，移动端优化排版
  - 字体、字号、行距、字间距、对齐方式、页宽等可调，实时生效并记忆
  - 深浅色与多主题主色；触控与键盘翻页（分页/滚动两种模式）
- 数据获取与版本管理
  - 一键在线同步：直接从 GitHub 下载 ArknightsGameData ZIP；显示阶段与进度
  - 本地 ZIP 导入：弱网/离线环境可手动导入
  - 版本显示：当前 commit 短 SHA + 抓取时间；支持“检查更新”
- 全文搜索（支持中文）
  - 内置 SQLite FTS5 全文索引，unicode61 分词 + CJK 串词短语匹配
  - 支持 AND/OR/NOT（前缀 `-`）与短语（双引号）；前缀匹配（ASCII 自动 `*`）
  - 无索引时自动回退逐条扫描；显示实时搜索进度；结果上限 500 条
- 人物统计
  - 自动统计每章/每活动的人物发言次数；按人物聚合并可一键跳转到该人物首次出现
- 收藏与划线
  - 阅读器段落“划线收藏”（内容指纹对齐，数据更新后不丢）；剧情/分组收藏汇总在列表页
- 多平台与更新
  - 桌面（Windows/macOS/Linux）：Tauri 2；内置自动更新
  - Android：支持在线更新（APK 下载+安装），iOS 可本地构建安装

## 🧱 技术架构

- 前端：Vite + React 19 + TypeScript + Tailwind 4
  - 组件与页面：`StoryList`（主线/活动/支线/肉鸽/密录）、`StoryReader`、`SearchPanel`、`CharactersPanel`、`Settings`
  - 状态与能力：收藏、划线高亮、阅读进度、主题与偏好、分享图
- 后端（Tauri + Rust）：
  - 同步与导入（`DataService::sync_data/import_zip_*`）：下载 GitHub ZIP 或本地 ZIP 并解压；维护 `version.json`
  - 全文索引（`rusqlite` FTS5）：构建/查询/状态；tokenize 与 CJK 处理
  - 数据整理：主线/活动/支线/肉鸽/密录分组；读取剧情文本与简介
  - 剧情解析器（`parser.rs`）：将原始脚本解析为可读段落（对话/旁白/系统/标题/选项）
  - Android 插件：自定义 APK 更新插件（Kotlin/OkHttp），用于下载并触发安装

## 📂 目录结构（关键）

```
src/                     # 前端 (React + TS)
  components/            # 视图组件（阅读器/列表/搜索/设置/人物等）
  hooks/                 # 业务 hooks（进度、偏好、收藏、更新等）
  services/api.ts        # 调用 Tauri 后端命令 + 事件监听
  lib/                   # 工具（素材 URL、段落摘要等）
  types/                 # TS 类型

src-tauri/               # 后端 (Rust + Tauri)
  src/
    lib.rs               # 应用初始化、插件与命令注册
    commands.rs          # Tauri 命令层（异步/线程池封装）
    data_service.rs      # 数据同步/导入、索引、搜索、分组与读取
    parser.rs            # 剧情文本解析
    apk_updater.rs       # Android 平台更新插件桥接
  gen/android            # Android 工程（Gradle 脚手架与插件实现）
  patches/tauri-plugin   # 覆盖的 tauri-plugin（对 mobile 适配）

dist/                    # 前端构建产物
```

## 🧭 命令与事件（前后端约定）

- 同步/版本：`sync_data`、`get_current_version`、`get_remote_version`、`check_update`
- 导入：`import_from_zip`、`import_from_zip_bytes`
- 索引：`get_story_index_status`、`build_story_index`
- 搜索：`search_stories`、`search_stories_with_progress`、`search_stories_debug`
- 剧情与分组：
  - `get_main_stories_grouped`、`get_activity_stories_grouped`、`get_sidestory_stories_grouped`、`get_roguelike_stories_grouped`、`get_memory_stories`
  - `get_chapters`、`get_story_categories`、`get_story_content`、`get_story_info`、`get_story_entry`
- 事件（前端监听）：`sync-progress`（同步/导入进度）、`search-progress`（搜索进度）

## ⚙️ 安装与运行

### 前置要求

- Node.js 18+，Rust（stable），pnpm/npm 任一包管理器
- 桌面：各平台原生依赖（如 Linux 需 `webkit2gtk-4.1` 等，见 CI 脚本）
- Android：Android Studio + SDK/NDK；iOS：Xcode（macOS）

### 开发

```bash
npm i

# 桌面开发
npm run tauri dev

# Android（首次需 init）
npm run tauri android init
npm run tauri android dev

# iOS（首次需 init）
npm run tauri ios init
npm run tauri ios dev
```

### 构建

```bash
# 桌面安装包
npm run tauri build

# Android APK
npm run tauri android build

# iOS
npm run tauri ios build
```

## 🔄 数据同步与目录

- 在线同步：后端从 `https://codeload.github.com/Kengxxiao/ArknightsGameData/zip/<ref>` 下载 ZIP，并解压至应用数据目录（由 Tauri `app_data_dir` 决定）
- 手动导入：支持从文件选择或字节流导入 ZIP（同样解压到数据目录）
- 版本信息：`ArknightsGameData/version.json` 保存 `{ commit, fetched_at }`，前端显示短 SHA 与“几分钟前/小时前/天前”

## 🔍 全文索引与搜索

- 存储：`story_index.db`（应用数据目录），`fts5(story_name, tokenized_content, story_code, raw_content, …)`
- 构建：前端在设置页可手动触发“重新建立全文索引”；同步/导入后也可构建
- 语法：支持空格分词、短语（中文自动逐字短语）、`OR`、前缀（ASCII 自动 `*`）、排除项（`-关键字`）
- 回退：索引不可用时自动线性扫描，仍能得到结果但速度较慢

## 📦 环境变量

见 `.env.example`：

- `TAURI_UPDATER_PUBKEY`、`TAURI_UPDATER_ENDPOINT`：桌面自动更新签名与更新 JSON 地址
- `VITE_ANDROID_UPDATE_FEED`：Android 更新 manifest（例如 `android-latest.json`）

## 🚀 CI / 发布

- 工作流：`.github/workflows/release.yml`
  - 使用 `tauri-apps/tauri-action` 打包桌面应用并创建 Release 草稿
  - Android 侧构建签名的 universal APK，上传至同一 Release，并生成 `android-latest.json`
- 所需机密：`TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`、`TAURI_UPDATER_*`、`ANDROID_KEYSTORE_*` 等（详见工作流脚本注释）

## 🙌 开源依赖与致谢

- 数据来源
  - ArknightsGameData（Kengxxiao/ArknightsGameData）
- 框架与运行时
  - Tauri 2（@tauri-apps/api, CLI；插件：opener/dialog/process/updater）
  - React 19、Vite、TypeScript
- UI 与工具
  - Tailwind CSS 4、tailwindcss-animate、class-variance-authority、clsx、tailwind-merge
  - lucide-react（图标）
- Rust 依赖
  - tauri、serde/serde_json、regex、lazy_static、walkdir
  - reqwest (rustls, blocking)、zip、rusqlite (bundled, vtab)、unicode-normalization（NFKC 归一化）
- Android 依赖
  - AndroidX（appcompat/webkit/activity-ktx）、Material Components
  - Kotlin Coroutines、OkHttp3（APK 下载）
- CI
  - tauri-apps/tauri-action、android-actions/setup-android、dtolnay/rust-toolchain、swatinem/rust-cache、actions/setup-node

向以上项目与社区维护者致以诚挚感谢！

## 📝 版权与声明

- 本项目仅用于学习与技术交流，不包含或分发官方资源
- 明日方舟及其相关素材的著作权归上海鹰角网络科技有限公司所有

