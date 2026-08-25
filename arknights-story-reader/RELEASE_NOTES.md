# 明日方舟剧情阅读器 2.0.1 发布说明

2.0.0 已发出，但不含审查修复。本版带上那些修复，并纠正 APK `versionCode`。

## 相对 2.0.0

- 后台 KeepAlive 跳过整棵子树绘制，切换页面不再叠在一起抢渲染。
- 去掉 tab 包装层 isolate，同步框不再被底栏盖住或点穿切走。
- 滚动按事件目标记账，避免长列表每帧扫树；首页跳收藏归顶不再被盖回。
- 搜索取消后不再被防抖自动搜复活。
- 同步/导入成功后版本查询不再占住任务锁。
- Android 更新清单改为原生层拉取，避开 GitHub Releases CORS。
- 构建时写入/回退 `tauri.properties`，避免 APK 再变成 versionCode=1 / versionName=1.0。

## 版本

清单统一为 `2.0.1`（versionCode `2000001`）。
