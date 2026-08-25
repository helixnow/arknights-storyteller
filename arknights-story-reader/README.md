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
  - 桌面（Windows/macOS/Linux）：Tauri 2；已接入 updater 插件（更新源现状见「CI / 发布」）
  - Android：支持在线更新（APK 下载+安装），iOS 可本地构建安装

## 🧱 技术架构

- 前端：Vite + React 19 + TypeScript + Tailwind 4
  - 组件与页面：`HomePanel`（继续阅读/统计）、`StoryList`（主线/活动/支线/肉鸽/密录）、`StoryReader`、`SearchPanel`、`CharactersPanel`、`Settings`
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
    models.rs            # 前后端共享的序列化结构
    asset_service.rs     # 素材 URL 候选解析
    character_table.rs   # 干员 name ↔ charId 索引
    image_sharer.rs      # 分享图落盘与系统分享
    apk_updater.rs       # Android 平台更新插件桥接
  tests/search_recall.rs # 召回率回归（需真实剧情数据，不进 CI）
  gen/android            # Android 工程（Gradle 脚手架与插件实现）
  patches/tauri-plugin   # 覆盖的 tauri-plugin（对 mobile 适配）

dist/                    # 前端构建产物
```

## 🧭 命令与事件（前后端约定）

完整清单以 `src-tauri/src/lib.rs` 的 `invoke_handler!` 为准，前端封装在 `src/services/api.ts`。

### Tauri 命令

| 分类 | 命令 | 说明 |
| --- | --- | --- |
| 同步/版本 | `sync_data`、`get_current_version`、`get_remote_version`、`check_update`、`is_installed` | 下载/解压 ArknightsGameData、读写 `version.json`、判断数据是否已安装 |
| 导入 | `import_from_zip`、`import_from_zip_bytes` | 从本地路径或字节流导入 ZIP |
| 索引 | `get_story_index_status`、`build_story_index` | 查询 FTS5 索引状态、重建索引 |
| 搜索 | `search_stories`、`search_stories_ex`、`search_segments`、`search_stories_with_progress`、`search_stories_debug` | 见下 |
| 剧情与分组 | `get_main_stories_grouped`、`get_activity_stories_grouped`、`get_sidestory_stories_grouped`、`get_roguelike_stories_grouped`、`get_memory_stories`、`get_chapters`、`get_story_categories` | 主线/活动/支线/肉鸽/密录目录 |
| 单篇剧情 | `get_story_content`、`get_story_info`、`get_story_entry`、`get_story_neighbors`、`get_story_category_name`、`get_story_preview_token` | 正文解析、简介、条目、上/下一篇、所属章节名、缩略图 token |
| 素材与人物 | `resolve_asset_urls`、`get_character_index` | 素材 URL 候选列表、干员 `name ↔ charId` 快照 |

搜索这一组的差别值得单独说明：

- `search_stories` 返回 `SearchResult[]`，是最早的同步接口，不发进度事件。
- `search_stories_with_progress` 结果结构与上面一致，但过程中会 emit `search-progress`。
- `search_stories_ex` 返回 `SearchResultsPage`（`results` + `totalMatched` + `truncated` + `facets` 分类计数），用于结果页的分类筛选。
- `search_segments` 返回 `SegmentSearchPage`（`hits` + `totalMatched` + `truncated`）。每条 `SegmentHit` 带 `segmentIndex`、`segmentType`、`characterName`、`matchedText` 和 `matchTarget`（`body` = 正文命中，`speaker` = 只有说话人名字命中，前端据此标注「按说话人命中」），因此搜索结果可以直接定位到剧情里的具体段落，而不是只能跳到篇首。
- `search_stories_debug` 额外返回一份 `logs`，用于排查「为什么这条没被搜到」。

`get_story_preview_token` 返回 `{ kind: "image" | "background", token } | null`：后端只挑出这篇剧情最有代表性的一张插画/背景的 token，前端再交给 `resolve_asset_urls` 展开成候选 URL 列表逐个尝试。返回 `null` 表示这篇确实没有可用插画，前端会永久缓存这个结论；抛错则只做短 TTL 缓存以便重试（见 `src/hooks/useStoryPreview.ts`）。

### 后端事件（Tauri `emit`，前端 `listen`）

- `sync-progress`：在线同步与 ZIP 导入的阶段与进度
- `search-progress`：搜索进度（无索引回退到线性扫描时尤其有用）
- `index-progress`：重建全文索引的进度

### 前端进程内事件（`window.dispatchEvent` / `addEventListener`）

这些是浏览器 DOM 事件，不经过 IPC，用来让互不相邻的面板保持同步：

- `app:data-updated`：剧情数据刚同步或导入完成。目录缓存、剧情缩略图缓存、人物索引、搜索面板、首页都会订阅它做整体失效与重载。
- `app:home-refresh`：打开剧情与从阅读器返回时广播，也是阅读进度唯一会变的时刻；首页与剧情列表据此刷新进度条。
- `app:open-favorites`：请求剧情列表直接切到「收藏」分类（首页的统计格会用）。
- `app:go-tab`：`CustomEvent`，`detail` 取 `"home" | "stories" | "characters" | "search" | "settings"`，用于跨面板跳转（例如人物页引导用户去设置页建索引）。
- `app:rebuild-story-index` / `app:story-index-updated`：设置页触发重建、自动索引完成后通知搜索面板刷新状态。

## ⚙️ 安装与运行

### 前置要求

- Node.js 18+（CI 用 `lts/*`），npm；Rust ≥ 1.89（CI 固定 `1.89.0`，原因见下方 CI 一节）
- 桌面：各平台原生依赖。Ubuntu 24.04 上 CI 装的是 `libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、`librsvg2-dev`、`libxdo-dev`、`libssl-dev`，本地可照抄
- Android：Android Studio + SDK/NDK；iOS：Xcode（macOS）

### 本地自检

CI 跑的就是这几条，提 PR 前在本地过一遍最省事：

```bash
npm test                         # 前端单元测试
npx tsc --noEmit                  # 类型检查
npm run build                     # tsc + vite build
cd src-tauri
cargo test --lib --locked         # 解析器 / 搜索 / 数据整理的单元测试
cargo test --test search_recall --locked  # 自建 fixture 的搜索召回测试
```

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

构建期变量（Vite，需 `VITE_` 前缀才会进前端产物）：

- `VITE_ANDROID_UPDATE_FEED`：Android 更新 manifest 的地址。release 工作流会把它指向该 Release 里的 `android-latest.json`；本地不设置时 Android 内更新入口不生效。

桌面自动更新的公钥与更新源**不是**环境变量，直接写在 `src-tauri/tauri.conf.json` 的 `plugins.updater` 里（`pubkey` + `endpoints`）。签名私钥则由 `tauri build` 读取 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

开发脚本还认这两个（见 `scripts/`）：`TAURI_DEV_HOST`（移动端真机调试指向的开发机地址）、`TAURI_CACHE_ROOT`（自定义 cargo/gradle 缓存位置）。

## 🚀 CI / 发布

### PR 门禁：`.github/workflows/ci.yml`

在 `pull_request` 以及推送到 `main` 时跑，两个并行 job（`defaults.run.working-directory` 统一设成 `arknights-story-reader/`，因为应用不在仓库根目录）：

- **frontend**：`npm ci` → `npm test` → `npx tsc --noEmit` → `npm run build`
- **rust**：`cargo test --lib --locked` → `cargo test --test search_recall --locked`（`src-tauri/`），工具链固定 `1.89.0`

几点值得记住：

- Rust 版本不能往下调。`src-tauri/Cargo.lock` 已入库，CI 使用 `--locked` 保证依赖解析可复现；锁定的依赖树里已有使用 edition2024 的 crate，1.83 这类旧工具链会在解析阶段直接失败。
- `cargo test --lib` 虽然不开窗口，仍然要装 `libwebkit2gtk-4.1-dev` 等原生依赖：Linux 上 `tauri → wry → webkit2gtk-sys` 是普通依赖，编译 lib target 就会跑它的 pkg-config build script。
- `src-tauri/tests/search_recall.rs` 的自建微型 fixture 会进入 PR 门禁；依赖真实剧情数据的用例标记为 `ignored`，仅在本地有相应数据时手动运行。

### 发布：`.github/workflows/release.yml`

在推送到 `release` 分支或手动触发时运行，且**只构建 Android**：校验五份清单中的版本号一致 → 创建草稿 Release → 构建并上传签名的 universal APK → 生成并上传 `android-latest.json` → 搬运上一个 Release 的桌面 `latest.json`（若存在，见下节）→ 发布 Release。工作流不会自动 bump 或回推版本；发版前必须先提交未占用的新版本，并同步更新 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 与 `src-tauri/Cargo.lock`。

所需机密为 `ANDROID_KEYSTORE_B64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。正式发布启用严格签名模式，release keystore 缺失、口令错误或 alias 无效时直接失败，不会回退到 debug keystore。实际工作流位于仓库根目录 `.github/workflows/release.yml`。

### 桌面更新源与手工发布

`tauri.conf.json` 已经把桌面 updater 指向 GitHub Release 的 `latest.json`：

```
https://github.com/helixnow/arknights-storyteller/releases/latest/download/latest.json
```

桌面端期望从被标记为 latest 的 Release 下载 `latest.json`。当前工作流不会构建桌面安装包或生成这个文件——`release.yml` 只产出 APK 和 `android-latest.json`。它只会在发布新 Release 前，把最近一个正式 Release 中已有的 `latest.json` 原样搬运过来（`Carry over desktop updater feed` 步骤）。feed 内仍指向原桌面 Release 的安装包和签名，因此不需要复制那些资产。若所有正式 Release 都没有 `latest.json`，搬运步骤会跳过，桌面端更新检查仍会得到 404；正式发布前应检查 Release 资产。

**首次上传桌面 feed（或发布新的桌面版本）必须手工完成**，步骤如下：

1. 在各目标平台上用配套私钥构建。私钥必须与 `tauri.conf.json` 里 `plugins.updater.pubkey` 配对，**不要**重新生成一对新钥匙，否则已安装的客户端会校验失败、拒绝更新：

   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="<私钥内容或文件路径>"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<私钥口令，没有则不设>"
   npm run tauri build
   ```

   `createUpdaterArtifacts` 已在 `tauri.conf.json` 开启，`src-tauri/target/release/bundle/` 会同时产出安装包与配套 `.sig`：Linux 为 `*.AppImage` + `.sig`，Windows 为 NSIS `*-setup.exe` + `.sig`，macOS 为 `*.app.tar.gz` + `.sig`。

2. 手写 `latest.json`（Tauri 2 updater 的静态 JSON 格式）。`version` 填本次桌面构建的应用版本；`signature` 填对应 `.sig` 文件的**内容**（不是路径）；`url` 指向同一个 Release 里上传后的资产：

   ```json
   {
     "version": "X.Y.Z",
     "notes": "",
     "pub_date": "YYYY-MM-DDTHH:mm:ssZ",
     "platforms": {
       "linux-x86_64":   { "signature": "<AppImage.sig 内容>",   "url": "https://github.com/helixnow/arknights-storyteller/releases/download/app-vX.Y.Z/arknights-story-reader_X.Y.Z_amd64.AppImage" },
       "windows-x86_64": { "signature": "<setup.exe.sig 内容>",  "url": "https://github.com/helixnow/arknights-storyteller/releases/download/app-vX.Y.Z/arknights-story-reader_X.Y.Z_x64-setup.exe" },
       "darwin-x86_64":  { "signature": "<app.tar.gz.sig 内容>", "url": "https://github.com/helixnow/arknights-storyteller/releases/download/app-vX.Y.Z/arknights-story-reader_x64.app.tar.gz" },
       "darwin-aarch64": { "signature": "<app.tar.gz.sig 内容>", "url": "https://github.com/helixnow/arknights-storyteller/releases/download/app-vX.Y.Z/arknights-story-reader_aarch64.app.tar.gz" }
     }
   }
   ```

   两个注意点：`productName` 是中文，`tauri build` 产出的文件名会带中文，上传前建议重命名为纯 ASCII 并保证 `url` 与重命名后的资产名一致，避免 URL 编码问题导致 updater 404；`version` 是桌面端自己的版本，落后于 Android 的版本号是正常状态——updater 只拿它与本机版本比较，不会与 Android 版本混淆。

3. 把安装包与 `latest.json` 一起上传到**当前 latest** 的 `app-v*` Release（`gh release upload <tag> <文件> --clobber`）。此后每次 Android 发布都会自动把这份 `latest.json` 搬运到新 Release，feed 不会再丢；但发布新桌面版本时仍需重复上述手工步骤。

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
  - actions/checkout、actions/setup-node、actions/setup-java、dtolnay/rust-toolchain、swatinem/rust-cache

向以上项目与社区维护者致以诚挚感谢！

## 📝 版权与声明

- 本项目仅用于学习与技术交流，不包含或分发官方资源
- 明日方舟及其相关素材的著作权归上海鹰角网络科技有限公司所有

