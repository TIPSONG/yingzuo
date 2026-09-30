# P0 桌面容器选型调查

调查日期：2026-09-22。范围：官方文档与限定应用工具目录的只读检查；本报告没有安装依赖、修改配置、启动 GUI 或操作浏览器。

## 建议

采用 **Electron + 现有原生 JS/CSS + WebContentsView**。这使现有页面直接成为 Windows 应用的管理界面，并把真正的 ComfyUI 放在同一个窗口内的独立网页视图中。此判断针对映作当前代码和需求；不是通用框架性能排名。

Electron 官方支持由主进程管理多个 `WebContentsView`，同时明确不推荐使用 `<webview>` 标签。原型阶段不采用已经弃用的 `BrowserView`，也不靠 iframe 绕开跨域限制。[嵌入方案](https://www.electronjs.org/docs/latest/tutorial/web-embeds)、[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)

| 方案 | 当前项目收益 | 当前项目成本 | 判断 |
| --- | --- | --- | --- |
| Electron | 前后端可用现有 JavaScript；独立网页视图、原生文件对话框和下载事件可直接使用 | 分发 Chromium，安装体积与运行内存需实测；应用负责及时升级运行时 | 首选 |
| Python + pywebview / WebView2 | 本机已有 Python、WebView2；Python 调本机服务容易 | 需要另装 pywebview；同窗多网页区域及权限边界需更多定制和验证 | 可作为较小工具的备选 |
| Tauri 2 + WebView2 | 可复用系统 WebView2；具备按窗口/来源配置能力的机制 | 新增 Rust、Windows C++ 构建工具链；当前没有可确认的现成开发环境，增加交付变量 | 本轮不选，保留备选 |

表中成本是基于本机现状的工程判断。pywebview 官方说明 Windows 使用 Edge Chromium，并提供 JS–Python 桥接；Tauri 官方列出 Rust、C++ Build Tools、WebView2 前置要求及 capability 机制。[pywebview 引擎](https://pywebview.flowrl.com/guide/web_engine.html)、[pywebview 桥接](https://pywebview.flowrl.com/guide/interdomain)、[Tauri 前置要求](https://v2.tauri.app/start/prerequisites/)、[Tauri capabilities](https://v2.tauri.app/security/capabilities/)

## 最小结构与通信边界

1. **管理界面**：沿用现有 HTML/CSS/JS；由应用自定义协议只提供打包内的前端资源。网页预览继续保留，便于独立调试。生产版不依赖 `preview.py` 常驻，也不把整个磁盘暴露为静态目录。
2. **ComfyUI 视图**：加载经过解析和校验的 `http://127.0.0.1:8188/`，保持它自己的 HTTP/WebSocket、上传和插件前端运行环境。它有独立 session，不加载管理界面的 privileged preload，不获得 Node.js 或通用文件/进程接口。固定本机地址只覆盖初版；任意远程服务另做配置边界。
3. **主进程**：持有窗口、视图、原生对话框、服务进程句柄和目录访问。管理界面只能调用具体方法，例如 `getServiceStatus()`、`showCanvas()`、`selectWorkflow()`、`saveWorkflowCopy()`、`openOutputFolder()`。每个 IPC 校验调用者、参数及目标，不能暴露任意 `exec`、`readFile(path)` 或透传 IPC。
4. **视图布局**：管理页报告画布区域的边界，主进程限制到窗口内再设置 `WebContentsView` bounds。弹窗出现或离开节点模式时隐藏/移除 ComfyUI 视图，避免原生网页层挡住菜单和按钮。窗口缩放、高 DPI、滚动及快捷键需专项验证。

两类 renderer 均显式设置 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`，保留 `webSecurity`；限制导航、新窗口和权限请求。官方强调隔离上下文仍需对桥接接口逐项过滤，并验证 IPC 来源。[上下文隔离](https://www.electronjs.org/docs/latest/tutorial/context-isolation)、[进程沙箱](https://www.electronjs.org/docs/latest/tutorial/sandbox)、[安全指南](https://www.electronjs.org/docs/latest/tutorial/security)

**边界说明**：这会限制 ComfyUI 网页接触映作的桌面能力，不会把 ComfyUI 的 Python 自定义节点变成沙箱。自定义节点仍在现有 ComfyUI 服务进程中运行。

## 不同 origin、工作流与 WebSocket

- 管理界面与 ComfyUI 视图不同 origin，不能直接读取彼此的 DOM 或 `window.app`。`WebContentsView` 也不是 DOM iframe，不能把 iframe 的 `contentWindow` 当成通信接口。
- 初版同窗先保证真实 ComfyUI 页面独立可用；宿主自己的状态查询与任务 API 走有固定目标和方法的主进程适配层。主进程请求不受网页 CORS 限制，但仍必须实施本机地址和端点限制；不能以 `webSecurity: false` 解决跨域。
- ComfyUI 自身页面可继续使用自己的同源 WebSocket。管理页若要显示队列/进度，由宿主适配层连接已配置服务，并只把需要的状态事件传回管理页；断线、重连和重复事件处理属于待验证项。
- **工作流标签同步需单独适配**：打开网页并不代表宿主 JSON 标签已进入 ComfyUI；UI 工作流 JSON 也不等于提交 `/prompt` 所需的 API 图。保留一层带版本的 ComfyUI 适配器，明确区分导入图、读取图、切换标签、执行图和保存图，避免在多处注入任意 JavaScript。
- 如确需页面桥接，采用最小消息类型与关联 ID、校验对象大小/结构、绑定到指定 ComfyUI view，并使用超时与错误回执。不能向 ComfyUI 页面暴露管理页的桌面 IPC。具体前端扩展接口与多标签模型由 ComfyUI 接入预研决定，当前报告不宣称已验证。

Electron 提供明确的 IPC 与 context bridge 机制；上述 ComfyUI 协议划分是本项目的架构建议。[Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc)

## 文件操作

- 现有管理页的浏览器 File API 可继续承担用户选择/拖入 JSON 后的解析，不必只为解析文件暴露绝对路径。
- 正式的“打开工作流 / 导出副本”通过主进程 `dialog` 让用户选择文件，再执行受限读写；取消不算错误，保存成功须以写入完成为准。[原生对话框](https://www.electronjs.org/docs/latest/api/dialog)
- ComfyUI 内部上传保留网页文件选择与 FormData 路径；需要真实 `.json`、`.png` 拖放和中文文件名验收，不能仅据浏览器兼容性推断全部成功。
- ComfyUI 网页下载由其 session 的 `will-download` 事件管理，跟踪 `done` 的 completed / cancelled / interrupted；模型下载、断点续传和校验另属于资源管理阶段。JSON 导出优先原生保存，不再用“已触发 Blob 点击”作为成功标准。[DownloadItem](https://www.electronjs.org/docs/latest/api/download-item)

## 本机已核实

| 项目 | 只读结果 |
| --- | --- |
| 当前项目 | 原生 JS/CSS；`package.json` 只有 Node 测试脚本，检查时没有 `node_modules/electron` |
| Node | `D:/agent/node/node.exe --version` 返回 `v24.19.0` |
| WebView2 | `C:/Program Files (x86)/Microsoft/EdgeWebView/Application/153.0.4234.48/msedgewebview2.exe` 存在 |
| Python webview | 已知 Python 3.11 的 `Lib/site-packages/webview` 不存在；不能据此断言所有其他虚拟环境均未安装 |
| Rust / Electron 命令 | 当前 PATH 的 `Get-Command cargo,rustc,electron` 没有结果；不等于整机完全未安装 |
| 可复用工具目录 | 限定检查 `D:/agent/tools`、`D:/agent/node`、`D:/agent/knowledge-launcher`、`D:/agent/LMSTUDIO`；未发现可直接用于本项目的独立 Electron runtime |
| 旧知识启动器 | `D:/agent/knowledge-launcher/launcher.py` 使用 Tkinter，并非现成的网页桌面容器 |

不从 LM Studio、Codex 等已安装应用拆取私有 Electron 运行时；版本、打包格式与更新周期应由本项目明确管理。

## 尚未验证 / P0 验收门槛

- 固定 Electron 版本安装、启动和 Windows 分发产物：本次调查未执行。
- 真实 ComfyUI 页面加载、插件节点、WebSocket、文件上传下载、图像预览与图生成：本报告未做运行验收。
- 原型管理页迁移到自定义协议后的资源路径、localStorage 迁移、剪贴板、拖放与 CSP：需实测。
- `WebContentsView` 弹窗遮挡、高 DPI、焦点、标签切换后图状态保持：需实测，特别对应此前“画布卡住不能点”的故障。
- 托盘、退出策略、既有外部服务与应用自启服务的所有权区分：需明确生命周期实现，只能停止本应用实际拥有的服务进程。
- 对工作流的同窗导入—编辑—导出完成可回读验证后，再确认 P0 桥接方案；端到端真实生成与日常功能接入列入后续阶段。

本轮结论是**选型与最小架构建议**，不是“桌面应用已完成”或“所有 ComfyUI 插件已兼容”的证明。
