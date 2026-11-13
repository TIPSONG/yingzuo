# P0：本机 ComfyUI 前端接入依据

检查日期：2026-09-22。此次仅检查本地源文件和已安装前端发行包，没有修改 ComfyUI、启动模型、读取凭据或调用生成队列。下面的“已确认”指源码层面；桌面中实际加载、参数回写、切换与重启仍须单独验收。

## 结论

可以先用 Electron `WebContentsView` 承载本机的完整 ComfyUI 页面，由桌面宿主调用固定桥接函数加载指定 JSON、读取完整工作副本、回写基础控件。不要猜测 `?workflow=` 路由，也不要重新实现 ComfyUI 节点编辑器。ComfyUI 页面无需取得 Node 或宿主 IPC 能力。

已安装前端也包含官方 **App Mode / App Builder**，可复用其现有模式与表单配置；它不等于 Windows 应用容器。首轮仍保留启动台表单适配，因为现有工作流不一定配置了 `extra.linearData`，第三方控件与子图提升参数也需要逐项验证。

## 本机版本与来源

| 项目 | 读取结果 | 本地依据 |
| --- | --- | --- |
| 后端 | `0.37.0` | `D:/agent/ComfyUI/comfyui_version.py` |
| 后端提交 | `b0f4b7b294ce482a2e071d9d762c133d38c7aa07` | `git rev-parse HEAD` |
| 前端 | `comfyui-frontend-package==1.53.6` | `requirements.txt` 和 `.venv/Lib/site-packages/comfyui_frontend_package-1.53.6.dist-info/` |
| 正式 JS 入口 | `/scripts/app.js` 导出 `window.comfyAPI.app.app` | `.venv/Lib/site-packages/comfyui_frontend_package/static/scripts/app.js` |

前端发行包带完整 source maps，以下行号均是 map 中 `sourcesContent` 对应原文件的行号，**不是压缩 JS 行号**。没有依赖当前网络文档推断已安装版本的行为。

### 启动就绪与 shim 缓存

实际发行 JS `settingStore-DDHzGrHr.js` 在构造 `ComfyApp` 后才发布 `window.comfyAPI.app.app`，而 `/scripts/app.js` 是立即读取这些全局字段的 shim。过早 import 会抛错，浏览器可缓存这个失败模块，之后仅重试相同 import 不能恢复。因此桥接先检查 `globalThis.comfyAPI?.app?.app`，未就绪返回 `NOT_READY`，完全不执行 import；已触发失败缓存的页面需要重新加载。

全局已发布不等于画布和启动草稿已经恢复。`src/scripts/app.ts` 349–351 的 `isGraphReady` 可安全检查根图是否初始化；`GraphCanvas.vue` 517–580 在设置、节点扩展及草稿恢复期间保持 `workspaceStore.spinner=true`。特别是 `app.ts` 988–990 已建立 `app.canvas`，但 1058–1063 仍在 await 扩展，随后 `GraphCanvas.vue` 555 才将 canvas 注册到 store、559 才发布 `window.app`。桥接因此要求 `globalThis.app === app`、`isGraphReady !== false`、`extensionManager.spinner !== true`，然后检查根图与 canvas；能避免早期 `getCanvas: canvas is null` 错误，也不会把 setup 失败后 finally 清除 spinner 当作成功。宿主应显示加载中的视图、有限重试 `NOT_READY`，不能把文档加载事件当作编辑器就绪。是否隐藏 WebContentsView 导致当前启动变慢仍需桌面实测，未从源码认定其为唯一根因。

Map 文件基目录：`D:/agent/ComfyUI/.venv/Lib/site-packages/comfyui_frontend_package/static/assets/`。

## 指定工作流加载与标签

`settingStore-DDHzGrHr.js.map` → `../../src/scripts/app.ts`：

- 1244–1268：`app.loadGraphData(graphData, clean=true, restore_view=true, workflow=null, options={})` 返回 `Promise<boolean>`，先调用 `beforeLoadNewGraph`。
- 1285–1307：回到根图、清理旧图并克隆输入数据，不能假设传入的 JSON 会直接作为运行态引用保留。
- 1332：调用 `loadSubgraphs(graphData)`；1444 配置根图；1549–1554 更新工作流状态并调用节点扩展钩子。
- 1598：成功返回 `true`。失败可能返回 `false` 或抛出异常，宿主不能仅以 Promise 完成判断成功。
- 1621–1624：`graphToPrompt()` 默认传入根图，用于后续真实提交；不应把 API prompt 反当作完整编辑器文档。
- 2273–2425：API 格式另有 `loadApiJson(apiData,fileName)`；P0 桥接仅接受带 `nodes` 数组的编辑器 JSON，不能静默猜测格式。

同一 map → `../../src/platform/workflow/core/services/workflowService.ts`：

- 601–628：切换前冻结当前 change tracker，保存草稿、节点预览和子图视口。
- 680–742：字符串名称主要用于新建临时工作流；非当前的同名已加载标签并不保证复用。因此反复以文件名调用 `loadGraphData` 有重复标签风险。
- 747–760：传入已有 `ComfyWorkflow` 对象可重新激活该工作流。
- 386–440：官方 `openWorkflow` 自带加载排队；宿主直接调用 `loadGraphData` 仍需自行串行化。

已实现的 P0 适配器用固定且唯一的宿主标签名称（建议 `yingzuo-<tabUUID>`）维护会话内名称到官方工作流对象的映射。首次加载先调用官方 store 的 `createNewTemporary` 创建目标对象（`workflowStore.ts` 324–331），再把对象交给 `loadGraphData`；加载结束核对当前工作流的唯一 `path` 和文档 `activeState.id` 均与目标一致，避免等待期间原生标签切换造成错误绑定。由于 Pinia 会把原对象包装为 Vue Proxy，不能直接用 `===` 比较创建结果和 `activeWorkflow`。验证后记录实际活跃代理；重载时只复用 `openWorkflows` 中同时匹配路径和文档 ID 的工作流。该映射不承担持久化，真实草稿由宿主先保存再切换。

## 完整序列化、子图与草稿

必须读取 **`app.rootGraph.serialize()`**。用户在子图内时 `app.graph` 可指向当前可见子图，使用它保存会丢失外围工作流。

- `settingStore-DDHzGrHr.js.map` → `src/scripts/changeTracker.ts` 397–418 使用 `app.rootGraph.serialize()` 捕获工作副本；244–248 明确防止加载期间将新图写回旧标签。
- `GraphView-Cx5xBruY.js.map` → `src/platform/workflow/persistence/composables/useWorkflowPersistenceV2.ts` 100–135 同样序列化根图并检查草稿保存失败；138–148 防抖并在 `pagehide` 冲刷。
- 同一 map → `useWorkflowTabState.ts` 1–24、35–95 表明浏览器标签指针按 `api.clientId` 与 workspace 隔离，存于 sessionStorage；不能把它当作桌面应用重启恢复的唯一来源。
- `settingStore-DDHzGrHr.js.map` → `src/platform/workflow/core/services/workflowService.ts` 627–628 保存子图视口。当前桥接保留完整图内容，但尚不承诺重建官方历史撤销栈或每个子图的导航历史。

子图描述使用 `graphId + nodeId + widgetName`，不能仅以节点 ID 查找；两个图内可能有相同节点 ID。定义级子图控件也可能被多个实例共享，实例差异与提升控件必须通过实际工作流验证，不应伪装成独立实例参数。

## 官方 App Mode / App Builder

`settingStore-DDHzGrHr.js.map`：

- `src/composables/useAppMode.ts` 7–42：Builder 已启用，官方 `setMode` 将模式写入 `workflowStore.activeWorkflow.activeMode`。
- `src/stores/appModeStore.ts` 208–247：从 `extra.linearData` 读取输入/输出选择，并将 Builder 修改写回根图；278–300：Builder 有额外初始化流程，不应只改 `activeMode` 冒充其完整入口。
- `src/platform/workflow/core/services/workflowService.ts` 668–671：初始模式来自 `extra.linearMode`，选择来自 `extra.linearData`。
- `src/stores/workspaceStore.ts` 47、105 暴露 `workflow` store；`main-xCuCK3ZS.js.map` 的 `src/App.vue` 24 把该 store 设为 `app.extensionManager`。

`GraphView-Cx5xBruY.js.map`：

- `src/components/appMode/AppModeToolbar.vue` 23–30 提供官方 “Build an App” 按钮并调用 `enterBuilder`。
- `src/components/builder/AppBuilder.vue` 119–148 根据用户选择登记输入控件；193–243 支持排序、重命名和删除；256–294 配置输出。

P0 仅提供 `graph` / `app` 固定模式切换。进入 `app` 前若缺少已配置的输入和输出，返回可读错误，保留原 JSON；不自动拼造 `linearData`，也不通过哈希资源名导入内部 Pinia 模块。

## 最小桥接契约

实现：[desktop/comfy-bridge-source.cjs](../../desktop/comfy-bridge-source.cjs)。每个函数产生固定 async IIFE，内部 `import('/scripts/app.js')`；参数由 `JSON.stringify` 序列化，文件名、提示词、控件名不拼入表达式。

| 宿主生成器 | 操作与结果 |
| --- | --- |
| `getCapabilitiesSource()` | `{ok,loadGraph,snapshot,parameters,appMode,workflow,connected}` |
| `loadGraphSource({graph,name})` | 加载编辑器 JSON；成功返回完整 snapshot；`false` / 异常明确失败 |
| `snapshotSource({expectedName?}={})` | `{ok,graph,nodes,workflow,connected,truncated}`；`graph` 为完整根图 |
| `applyParametersSource({updates,expectedName?})` | `updates:[{graphId?,nodeId,widgetName,value}]`；只允许基础可编辑控件的文本、有限数值和布尔值 |
| `setModeSource('graph' / 'app',expectedName?)` | 切换当前工作流模式，不修改表单配置 |

错误形状为 `{ok:false,error:{code,message}}`。第三方控件回调抛错时增加 `needsSnapshot:true`，宿主必须重新读取实际状态，不能宣称本次修改已原子回滚。

成功返回的 `workflow.hostName` 是会话映射中的稳定宿主名称；原 `workflow.name` 仍是官方工作流 key，`workflow.documentId` 返回官方文档 ID。保存、参数回写、模式切换应始终带 `expectedName`。桥接同时核对当前 `ComfyWorkflow.path` 与 `activeState.id`（必要时取 `initialState.id`），不靠显示名称或 Proxy 对象引用；若用户在内嵌 ComfyUI 切到了其他标签，返回 `WORKFLOW_CHANGED`，不返回图、不修改控件。只匹配路径或只匹配文档 ID 都拒绝，原生重命名同一工作流则继续识别。省略该参数仅用于兼容旧调用和初始能力探测，不应在正式草稿保存中使用。

`nodes` 描述最多 500 个节点、合计 2,000 个控件、每节点 80 个控件、每个下拉最多 500 个选项；超限只截描述并标记 `truncated`，**不截断保存的完整 graph**。已连线、只读、重复名称、按钮等控件拒绝回写。省略 `graphId` 只在根图查找，避免误改子图。

连接状态为明确布尔值，来自正式 `app.api.socket.readyState === 1`；`settingStore-DDHzGrHr.js.map` → `src/scripts/app.ts` 319 声明 `api`，468 在构造函数中赋值 `this.api = api`；`api-X7ElNdW-.js.map` → `src/scripts/api.ts` 380、733–734 定义并更新 socket。socket 未建立、断开或当前版本缺少该字段均返回 `false`；它只证明 WebSocket 当前连通，不证明 GPU、模型、节点或所有 HTTP API 可用。

## P0 必验项目与风险

1. **版本依赖**：shim 是正式入口，但 workflow store 与模式字段仍可能随前端升级改变；更新后必须重跑探测与往返测试。
2. **串行切换**：先 snapshot 当前工作副本并可靠落盘，再加载下一图；加载失败恢复旧副本，并保留错误。不要在快速点击时并发调用加载。
3. **草稿与撤销区别**：图、参数、子图保留不等于 ComfyUI 撤销栈保留；反复 `loadGraphData` 会重置 tracker，P0 不承诺跨标签撤销历史。
4. **隐藏视图**：表单/管理页切换时应保留同一个 ComfyUI WebContentsView，不要每次销毁或导航。重新显示时检查尺寸、输入焦点和画布刷新。
5. **回调与自动队列**：基础控件按官方 `setValue` / callback 路径更新；第三方回调可能有副作用。桥接参数回写前强制要求 `app.extensionManager.queueSettings.mode === 'disabled'` 且 `app.ui.autoQueueEnabled !== true`，自动模式或现代队列状态未知均返回 `AUTO_QUEUE_ENABLED`，不修改控件。这是内存 store 状态，不是服务端 settings key；本机 `queueSettingsStore.ts` 的初始模式为 `disabled`。UI 验收仍核对运行菜单，桥接不悄悄替用户更改队列设置。
6. **跨域边界**：`server.py` 159–197 默认检查 loopback Host/Origin。以 ComfyUI 本身页面承载画布可避免从启动台页面直接跨域请求；宿主 API 接入仍应另行验证，不为省事开启通配 CORS。
7. **正式工作流**：用文生图与包含原生子图的多图编辑图分别检查加载→修改→切换→返回→导出，核对子图定义、模型引用和参考图路径。API 格式与纯结构导入预览不可冒充完成了真实执行转换。
8. **应用验收**：真正的 Windows 窗口、托盘、文件持久化、进程管理属于桌面宿主；不能以 App Mode 或浏览器独立窗口替代。

## 已做验证

`node --test tests/comfy-bridge-source.test.cjs`：18 项通过。覆盖完整根图保存、稳定标签复用、显式加载失败、字符串不执行、子图重号、整批预校验、已连接/按钮/重名控件拦截、类型及下拉值、模式配置缺失、描述截断、第三方回调失败、自动队列拦截、同路径不同文档拒绝、加载期间原生标签变更、控件回调切换身份、Vue Proxy 包装兼容，以及启动就绪前不导入 shim、不覆盖仍在恢复中的草稿。测试使用模拟 ComfyUI API 验证桥接逻辑；不把模拟测试视作真实前端验收。
