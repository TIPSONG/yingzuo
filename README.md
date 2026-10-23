# 映作 · Yingzuo

面向 Windows 的本地 AI 绘图桌面应用，将服务启停、多工作流标签、节点编辑、参数表单、任务队列和作品管理放在一个窗口中。绘图由本机 ComfyUI 执行，提示词润色可连接 LM Studio。

> **当前版本：0.1.0-alpha.1，开发分支 `feat/grovebot-impl`。**
> 程序实现、自动回归和 Windows 打包已完成；真实 ComfyUI／LM Studio／GPU 操作仍待人工验收。 [PR #11](https://github.com/TIPSONG/yingzuo/pull/11) 保持草稿、未合并。有限支持项见[开发进度](./docs/development/Grovebot开发进度.md)，人工验收见[待验收清单](./docs/development/待Codex验收.md)。

## 下载与运行

前往 [0.1.0-alpha.1 Release](https://github.com/TIPSONG/yingzuo/releases/tag/v0.1.0-alpha.1) 下载 Alpha 预发布版：

- **安装版**：[Yingzuo-Setup-0.1.0-alpha.1-x64.exe](https://github.com/TIPSONG/yingzuo/releases/download/v0.1.0-alpha.1/Yingzuo-Setup-0.1.0-alpha.1-x64.exe)，按安装向导启动。
- **便携版**：[Yingzuo-Portable-0.1.0-alpha.1-x64.exe](https://github.com/TIPSONG/yingzuo/releases/download/v0.1.0-alpha.1/Yingzuo-Portable-0.1.0-alpha.1-x64.exe)。如需将数据保存在程序旁，在 exe 同目录新建空文件 `portable.flag`，首次启动后使用该目录下的 `data/`。
- `SHA256SUMS.txt` 和 `artifacts.json` 提供文件校验值；`smoke-result.json`、`init-result.json` 是打包后的自动自检结果。

这是 **Windows x64、未签名的 Alpha 构建**，不是已经完成真机验收的稳定版。应用不附带 ComfyUI、LM Studio、模型权重或 Python 环境；下载 exe 后无需安装 Node.js。

首次打开后，在“设置”中填写实际的 ComfyUI 目录、Python 可执行文件、服务地址，以及需要时的 LM Studio CLI／API 地址。默认地址分别为 `http://127.0.0.1:8188/` 和 `http://127.0.0.1:1234/v1`；默认路径来自开发设备，需要按自己的安装位置修改。

**选择工作流 → 启动或连接已有服务 → 表单／节点编辑 → 可选润色 → 排队生成 → 查看与导出图片。**

关闭窗口默认缩到托盘；托盘提供退出入口。退出时会处理本应用正在运行的任务、保存草稿，并检查服务归属和后端队列。无法确认任务结束而选择“仍然退出”时，绘图及 LM Studio 服务保持运行。

## 桌面版功能

以下为程序实现范围，不代表已经完成全部人工验收。

| 页面 | 功能 |
| --- | --- |
| 首页／服务与日志 | 探测、按需启停本应用管理的本机服务；日志与诊断导出；版本检查，只提示更新，由用户发起 |
| 创作工作区 | 真实 ComfyUI 节点画布与参数表单；多标签草稿；导入 JSON、选择模板、新建空白画布；运行／Ctrl+Enter、批量生成、参考图、Gemma 润色 |
| 模板库 | 模板版本、固定表单版本、自定义参数、映射检查；诊断、替代建议、单字段修复与撤销；图和参考素材包导入／导出 |
| 在线资源 | Hugging Face／Civitai 搜索、断点续传、SHA-256 校验、工作流依赖检查与补齐 |
| 作品与收藏 | 任务输出关联、目录扫描、图片查看器、元数据、文件定位、原图／分享副本导出、收藏板 |
| 资源与维护 | 模型扫描、详情、引用检查、快捷使用、移动；插件启用／禁用／安装／更新／移除；备份、校验、恢复、回收区 |
| 任务队列 | 绘图任务依次执行；按后端能力取消任务；重试、状态核对与重启恢复；未知状态重试需要确认 |
| 设置 | 服务与文件路径、加密凭据、批量上限、托盘、更新频率；深色／浅色／跟随系统，默认／NASA 朋克皮肤 |

五种既有模板布局：文生图、多图编辑、Gemma 润色文生图、Gemma 润色多图编辑、单独润色提示词。实际运行需要匹配的节点、模型与服务。

导入诊断不会仅因“同为 GGUF”就判定模型可以互换。需要更换加载器、修改连线或跨架构时，不会只替换文件名；没有可靠候选时保留待核实状态。

## 本轮修复与验证

2026-10-15，代码基线 [`aab1998`](https://github.com/TIPSONG/yingzuo/commit/aab1998255f4bd6876f086e59fa1a72c578f1f2c) 完成 RR01–RR08 修复：

- 保存与导出：不再将普通模型名猜成凭据；敏感输入位置无法确认时阻止保存／导出，并保留内存草稿。模板表单、任务快照、图包和修复副本采用相应的敏感字段检查。
- 迁移与备份：检查旧 API 图、UI 图、表单及未引用文件；迁移失败或检查未完成时阻止应用备份；历史任务与版本引用保留。
- 退出与任务：退出服从环境锁及提交暂停租约；快捷使用同样检查最终参数和固定表单约束。
- 设置与界面：迟到的保存响应不清除新输入；修复资源页按钮事件、图片查看器及标题栏裁切。
- 截图工具：接口不匹配、页面异常或加载未完成时失败，不再生成误导性的成功记录。增加必跑 Chrome CI 作业。

| 验证项 | `aab1998` 结果 |
| --- | --- |
| `npm run check`：语法、接口白名单、Node 回归 | 438 项：437 通过、1 跳过、0 失败 |
| `npm run test:browser`：真实无头 Chrome，包含于 Node 回归 | 13 通过、0 跳过 |
| Python 部署基线测试 | 7 通过 |
| Windows／Linux CI | 通过 |
| Windows 安装包与便携版构建 | 通过 |
| 打包后原生模块自检、隔离数据根业务初始化 | 通过 |

跳过的 1 项是需要 `COMFYUI_WORKFLOWS_DIR` 的实际工作流目录检查。上述结果绑定指定代码提交，后续提交以各自的 CI 为准。

[回归 CI](https://github.com/TIPSONG/yingzuo/actions/runs/38686551420) · [Windows 构建与自检](https://github.com/TIPSONG/yingzuo/actions/runs/38686551049) · [56 张界面截图](./docs/development/ui-shots/README.md)

截图覆盖 14 个场景 × 4 种配色，使用真实桌面页面和明确的接口替身；manifest 记录源文件哈希。截图、模拟集成和打包自检均不代替真实 ComfyUI／GPU 验收，人工验收栏仍留空。

## 数据与配置

| 运行方式 | 默认应用数据目录 |
| --- | --- |
| 源码开发 | 项目下 `.local/data/` |
| 安装版，或未启用便携数据模式 | Electron 用户数据目录下的 `data/`（通常为 `%APPDATA%\映作\data`） |
| 便携版且同目录存在 `portable.flag` | exe 所在目录下的 `data/` |
| 显式设置 `YINGZUO_DATA_ROOT` | 使用该环境变量指定的目录 |

应用数据包括 `config.json`、`yingzuo.sqlite`、`workspace.json`，以及 `drafts/`、`closed-workflows/`、`templates/`、`task-snapshots/`、`references/`、`favorites/`、`exports/`、`logs/`、`backups/` 等目录。生成原图位于设置中的 ComfyUI 输出目录，默认是 `<ComfyUI>/output`；可从作品页定位文件。

模板固定保存在应用数据目录的 `templates/`，旧自定义模板目录设置会被忽略并提示。旧 `.local` 数据迁移采用复制方式，保留源文件。敏感节点输入使用系统加密凭据引用；加密不可用或字段无法可靠定位时，会明确阻止相关保存操作。

配置优先通过应用“设置”页修改。`desktop/config.local.json` 是旧开发配置的兼容入口，不作为当前设置教程；机器路径、凭据和 `.local/` 数据不应提交到仓库。

## 从源码开发

需要 Node.js **22.12 或更新版本**。Electron **44.4.3**、依赖版本及锁文件随仓库维护。开发当前 Alpha 时使用 `feat/grovebot-impl` 分支：

```powershell
git clone --branch feat/grovebot-impl https://github.com/TIPSONG/yingzuo.git
cd yingzuo
npm ci
npm run desktop
```

`npm run desktop` 通过正式入口启动，包含单实例检查与启动前恢复流程。ComfyUI 与 LM Studio 需另行安装；服务地址当前限定为本机 HTTP。

桌面工作区单图上限 8 MB，最多 20 个标签。API 格式工作流需要连接 ComfyUI，由其接口重建可视图；不支持的参数控件仍在节点画布编辑。真实 Gemma 节点名称、输入契约及模型兼容性仍需在目标环境核对。

### 自动检查

```powershell
npm run check
npm run test:browser
python -m unittest discover -s tests -p test_p0_baseline.py -v
```

浏览器测试使用固定依赖 `puppeteer-core` 和本机 Chrome。可用 `CHROME_PATH` 指定浏览器；CI 专项作业设置 `REQUIRE_BROWSER_TESTS=1`，缺浏览器时失败而非跳过。普通本地测试没有 Chrome 时会注明跳过。

可选的实际工作流目录检查只读取 JSON，不启动生成任务；其断言依赖测试中的模型清单，需使用匹配的工作流夹具：

```powershell
$env:COMFYUI_WORKFLOWS_DIR = 'D:\your-comfyui\user\default\workflows'
npm test
```

重拍静态界面截图：

```powershell
npm run screenshots -- --chrome 'C:/Program Files/Google/Chrome/Application/chrome.exe'
```

### Windows 打包

在 Windows x64 上构建，原生模块需要对应 Electron ABI：

```powershell
npm ci
npm run build:win
```

产物位于 `dist/`。GitHub Actions 的 [Windows build](./.github/workflows/windows-build.yml) 执行打包后自检及隔离数据根初始化，再整理 `dist/release/` 为完整的 7 个文件：安装包、便携版、blockmap、两份清单和两份自检结果。Actions 上传这个目录，发布前对下载解压后的实际目录再次验证：

```powershell
node tools/release-assets.cjs verify <解压目录>
```

发布使用仓库内的统一入口，需要环境变量 `GITHUB_TOKEN`（仓库 Contents 写权限），不要把令牌写进文件或命令参数：

```powershell
node tools/publish-release.cjs <解压目录> v<版本号> <40位构建提交SHA>
```

默认创建或补齐草稿；明确发布时在末尾加 `--publish`。脚本校验实际待上传的完整 7 个文件字节，重新核对远端资产集合、大小和 SHA-256 后才公开为预发布版。版本和标签必须一致，提交 SHA 必须来自该次构建；拒绝修改已有公开 Release 或覆盖冲突标签／资产。同一标签只由一个发布者操作，上传期间不要手动发布或改动草稿。

Actions 产物有保留期限，公开下载使用 Releases。旧 Alpha 1 缺少的 blockmap 若无法从原构建取回，应保留缺件说明，不能重新构建并伪装成同名历史产物；该版本不因新增检查自动成为“完整清单已验证”。旧的仓库外六文件发布脚本已停用，后续只使用上述入口。

## 原 A 测 WebUI 预览

根目录 `index.html` 是保留的早期界面原型，与 `desktop/workbench.html` 桌面工作台分开。预览无需 npm 依赖、ComfyUI 或模型：

```powershell
python preview.py --open
```

也可运行 `Start-Preview.cmd`，或访问脚本启动的 `http://127.0.0.1:8840/`。服务只监听本机。

A 测预览中的润色、生成、队列、在线管理等属于演示交互，不启停真实服务、不生成或导出真实图片。JSON 解析与修改逻辑可用，但模型清单为静态快照。浏览器草稿保存在本地存储，参考图只在本次会话有效；导入上限 2 MB、结构预览最多 120 个节点。

## 下一步与已知边界

程序任务与审阅修复进入真机验收阶段；早期 P0–P7 天数估算属于历史规划，不再作为当前剩余排期。

原 82 项任务现为 79 项程序完成、3 项有限支持，未进行人工验收的部分继续保留。各轮修复、测试和构建的对应提交见[当前状态与验证证据](./docs/development/当前状态与验证证据.md)；发布清单一致性另由 [Issue #16](https://github.com/TIPSONG/yingzuo/issues/16) 跟踪。

1. 在 Windows 上验证真实节点画布、多标签切换、表单与画布同步、快捷键、焦点和托盘退出。
2. 核对 Gemma 节点与 LM Studio 契约，运行既有文生图、多图编辑及润色工作流，验证串行 GPU 队列和输出关联。
3. 验证服务归属、外部 ComfyUI 任务、模型移动、更新失败恢复，以及 Windows 文件占用与 Worker 句柄释放。
4. 完成安装／升级／便携数据、系统加密、深浅主题及大量作品浏览验收，再决定稳定版发布与 PR 合并。

插件安装使用受限 Git 后端，尚未集成 ComfyUI-Manager；未知自定义节点在缺少定义缓存时的敏感字段识别仍有边界。更完整的限制、步骤与验收证据见下列项目资料。

## 目录与项目资料

```text
desktop/                      Electron 入口、服务、存储、原生画布桥接与桌面界面
shared/                       Schema、表单、工作流检查与敏感字段策略
tests/                        单元、模拟集成、浏览器和部署基线测试
tools/                        检查、打包、截图、进度与部署基线工具
docs/development/             程序进度、交接、人工验收清单与截图
index.html / app.js / style.css  早期 A 测 WebUI
preview.py / Start-Preview.cmd  本机预览入口
assets/                       标识和示例图片
```

- [程序任务与开发进度](./docs/development/Grovebot开发进度.md)
- [当前状态与验证证据](./docs/development/当前状态与验证证据.md)
- [待人工验收清单](./docs/development/待Codex验收.md)
- [Grovebot 历史交接记录](./docs/development/交接-下一个agent.md)
- [交付记录](./docs/development/交付记录.md)
- [产品规格](./docs/产品规格.md)
- [排期总览 Issue #1](https://github.com/TIPSONG/yingzuo/issues/1) 与 [项目 Issues](https://github.com/TIPSONG/yingzuo/issues)
- [A 测预览说明](./docs/A测预览说明.md)
- [P0 接入研究（历史）](./docs/research/P0桌面接入验证.md)
- [Gemma 集成说明](./docs/Gemma集成说明.md)
