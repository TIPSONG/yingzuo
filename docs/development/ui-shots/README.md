# UI 截图（静态预览）

通过真实 workbench 页面、明确的 preload 替身接口和仓库示例图片生成，共 14 个场景 × 4 种配色 = 56 张。截图不是 Windows/Electron/ComfyUI/GPU 人工验收。

重新生成：

```text
npm ci
npm run screenshots -- --chrome "C:/Program Files/Google/Chrome/Application/chrome.exe"
npm run test:browser
```

CI 的独立 Chrome 作业设置 `REQUIRE_BROWSER_TESTS=1`；缺浏览器或依赖时失败，不能跳过。普通本地仅单元测试场景可在无 Chrome 时跳过浏览器测试。

脚本只点击真实导航、收藏、查看器和设置控件，不写入假页面 HTML，也不隐藏错误。截图等待接口全部结束、页面内容就绪、图片解码和有限动画完成。未定义接口、JavaScript 异常、请求失败、可见错误与未完成加载均会阻止成功；失败退出非零并写 `capture-failure.json`，不留下成功的 `manifest.json`。

[manifest.json](./manifest.json) 记录渲染时 HEAD、源文件是否未提交、实际界面/替身/示例图 SHA-256、浏览器、视口 1440×960、DPR 1、场景和已调用接口。`sourceDirty: true` 时 HEAD 是基础提交，`sourceFiles` 才是实际渲染字节的依据；截图提交可在其后。捕获期间相关源文件变化会使本次任务失败。

2026-10-23 核对：当前保存的 56 张截图属于 `aab1998` 的历史材料。manifest 中 15 个界面／图片源文件哈希与该提交一致，但 4 个捕获工具／替身文件哈希不一致，尚不能把整个捕获环境视为该提交的精确复现。详情见[当前状态与验证证据](../当前状态与验证证据.md)。需要新证据时重新捕获并保留新的 manifest，不修改旧清单来消除差异。

| 场景 | 默认深色 | 默认浅色 | NASA 深色 | NASA 浅色 |
|---|---|---|---|---|
| 首页 | [default](./default-home.png) | [light](./light-home.png) | [nasa](./nasa-home.png) | [nasa-light](./nasa-light-home.png) |
| 创作工作区（未连接编辑器） | [default](./default-create.png) | [light](./light-create.png) | [nasa](./nasa-create.png) | [nasa-light](./nasa-light-create.png) |
| 新建工作流 | [default](./default-create-start.png) | [light](./light-create-start.png) | [nasa](./nasa-create-start.png) | [nasa-light](./nasa-light-create-start.png) |
| 模板库 | [default](./default-templates.png) | [light](./light-templates.png) | [nasa](./nasa-templates.png) | [nasa-light](./nasa-light-templates.png) |
| 在线资源 | [default](./default-online.png) | [light](./light-online.png) | [nasa](./nasa-online.png) | [nasa-light](./nasa-light-online.png) |
| 作品网格（三张示例图） | [default](./default-assets.png) | [light](./light-assets.png) | [nasa](./nasa-assets.png) | [nasa-light](./nasa-light-assets.png) |
| 作品空状态 | [default](./default-assets-empty.png) | [light](./light-assets-empty.png) | [nasa](./nasa-assets-empty.png) | [nasa-light](./nasa-light-assets-empty.png) |
| 收藏板（两张示例图） | [default](./default-favorites.png) | [light](./light-favorites.png) | [nasa](./nasa-favorites.png) | [nasa-light](./nasa-light-favorites.png) |
| 作品查看器 | [default](./default-assets-viewer.png) | [light](./light-assets-viewer.png) | [nasa](./nasa-assets-viewer.png) | [nasa-light](./nasa-light-assets-viewer.png) |
| 资源与维护（模型清单） | [default](./default-resources.png) | [light](./light-resources.png) | [nasa](./nasa-resources.png) | [nasa-light](./nasa-light-resources.png) |
| 任务队列 | [default](./default-queue.png) | [light](./light-queue.png) | [nasa](./nasa-queue.png) | [nasa-light](./nasa-light-queue.png) |
| 服务与日志 | [default](./default-services.png) | [light](./light-services.png) | [nasa](./nasa-services.png) | [nasa-light](./nasa-light-services.png) |
| 设置上半部分 | [default](./default-settings.png) | [light](./light-settings.png) | [nasa](./nasa-settings.png) | [nasa-light](./nasa-light-settings.png) |
| 设置下半部分与凭据 | [default](./default-settings-lower.png) | [light](./light-settings-lower.png) | [nasa](./nasa-settings-lower.png) | [nasa-light](./nasa-light-settings-lower.png) |
