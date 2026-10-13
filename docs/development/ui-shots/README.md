# UI 截图（静态预览）

由仓库内脚本 `tools/ui-shots.mjs` 生成（RV15）：静态托管 `desktop/workbench.html`，注入 `tools/ui-shots/stub.cjs` 替身 preload，内容统一来自 `tools/ui-shots/fixtures.json`。
主题与皮肤只通过替身 `settings.get` 返回的 `ui.theme` / `ui.skin` 驱动（走真实 `loadSettings → applyAppearance` 路径），截图前等待主题过渡动画结束。

生成时的 git HEAD、浏览器版本、视口（1440×960）与 DPR（1）以及每张图实际的主题/皮肤记录在 [manifest.json](./manifest.json)。

重新生成：

```
npm i --no-save puppeteer-core
node tools/ui-shots.mjs            # 可加 --chrome <路径> --out <目录>
```

说明：这是静态页面 + 替身数据，不代表真机 Electron/ComfyUI 已连接状态；人工验收仍需在 Windows 真机上进行。

## 默认皮肤 · 深色（`ui.theme=dark`，`ui.skin=default`）

| 页面 | 文件 |
| --- | --- |
| 首页 | [default-home.png](./default-home.png) |
| 创作工作区 | [default-create.png](./default-create.png) |
| 创作 · 起始页 | [default-create-start.png](./default-create-start.png) |
| 模板库 | [default-templates.png](./default-templates.png) |
| 在线资源 | [default-online.png](./default-online.png) |
| 作品与收藏 | [default-assets.png](./default-assets.png) |
| 资源与维护 | [default-resources.png](./default-resources.png) |
| 任务队列 | [default-queue.png](./default-queue.png) |
| 服务与日志 | [default-services.png](./default-services.png) |
| 设置 | [default-settings.png](./default-settings.png) |

## 默认皮肤 · 浅色（`ui.theme=light`，`ui.skin=default`）

| 页面 | 文件 |
| --- | --- |
| 首页 | [light-home.png](./light-home.png) |
| 创作工作区 | [light-create.png](./light-create.png) |
| 创作 · 起始页 | [light-create-start.png](./light-create-start.png) |
| 模板库 | [light-templates.png](./light-templates.png) |
| 在线资源 | [light-online.png](./light-online.png) |
| 作品与收藏 | [light-assets.png](./light-assets.png) |
| 资源与维护 | [light-resources.png](./light-resources.png) |
| 任务队列 | [light-queue.png](./light-queue.png) |
| 服务与日志 | [light-services.png](./light-services.png) |
| 设置 | [light-settings.png](./light-settings.png) |

## NASA 朋克 · 深色（`ui.theme=dark`，`ui.skin=nasa-punk`）

| 页面 | 文件 |
| --- | --- |
| 首页 | [nasa-home.png](./nasa-home.png) |
| 创作工作区 | [nasa-create.png](./nasa-create.png) |
| 创作 · 起始页 | [nasa-create-start.png](./nasa-create-start.png) |
| 模板库 | [nasa-templates.png](./nasa-templates.png) |
| 在线资源 | [nasa-online.png](./nasa-online.png) |
| 作品与收藏 | [nasa-assets.png](./nasa-assets.png) |
| 资源与维护 | [nasa-resources.png](./nasa-resources.png) |
| 任务队列 | [nasa-queue.png](./nasa-queue.png) |
| 服务与日志 | [nasa-services.png](./nasa-services.png) |
| 设置 | [nasa-settings.png](./nasa-settings.png) |

## NASA 朋克 · 浅色（RV12 新增）（`ui.theme=light`，`ui.skin=nasa-punk`）

| 页面 | 文件 |
| --- | --- |
| 首页 | [nasa-light-home.png](./nasa-light-home.png) |
| 创作工作区 | [nasa-light-create.png](./nasa-light-create.png) |
| 创作 · 起始页 | [nasa-light-create-start.png](./nasa-light-create-start.png) |
| 模板库 | [nasa-light-templates.png](./nasa-light-templates.png) |
| 在线资源 | [nasa-light-online.png](./nasa-light-online.png) |
| 作品与收藏 | [nasa-light-assets.png](./nasa-light-assets.png) |
| 资源与维护 | [nasa-light-resources.png](./nasa-light-resources.png) |
| 任务队列 | [nasa-light-queue.png](./nasa-light-queue.png) |
| 服务与日志 | [nasa-light-services.png](./nasa-light-services.png) |
| 设置 | [nasa-light-settings.png](./nasa-light-settings.png) |
