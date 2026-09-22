# 映作 · Yingzuo

面向 Windows 的本地 AI 绘图工作台，让启动服务、切换工作流、生成、找图和管理资源在一个应用中完成。

> **当前版本：0.1.0-alpha.1，A 测原型与 Windows 桌面接入验证版。**
> 已加入独立 Electron 窗口的开发入口，真实 ComfyUI 桥接正在进行 UI 验收，**P0 尚未标记完成**。原 A 测 WebUI 保留；其中绘图、润色和队列仍为演示。服务控制、托盘及正式桌面安装包尚未交付。

## 为什么做这个项目

使用 ComfyUI 和 LM Studio 时，启停服务、切换工作流、找生成图片需要在多个窗口、脚本和文件夹之间跳转。映作把这些日常操作放到一个入口，同时保留完整节点编辑能力。

目标使用流程：

**打开应用 → 选择工作流 → 按需启动服务 → 表单或节点编辑 → 可选 Gemma 润色 → 排队生成 → 查看／导出图片。**

## 当前已经能体验什么

| 功能 | 当前状态 |
| --- | --- |
| 首页、创作、资源、作品、收藏和设置 | 可点击的 A 测界面 |
| A 测多工作流标签 | 独立草稿、复制、重命名、关闭、恢复、刷新保留 |
| A 测简洁表单／节点模式 | 可切换；节点模式是结构预览，不执行真实节点编辑 |
| 桌面真实画布接入 | 独立窗口内接入本机 ComfyUI；桥接实现已加入，实际编辑与切换正在 UI 验收 |
| 桌面工作副本与参数 | 实现独立副本、根图快照、基础参数回写、本机草稿和 JSON 导出；完整操作链正在验收 |
| A 测新建工作流 | 导入 JSON、选择模板、空白节点画布三种入口 |
| A 测 JSON 导入 | 文件选择、粘贴与拖放处理；普通工作流和 API 格式；保留子图 |
| 导入诊断 | 根据清单快照分析模型引用、用途、格式，显示问题位置及有依据的替代建议 |
| 修复工作副本 | 预览单字段替换、应用、复查、撤销、JSON 预览和复制 |
| 启动台润色、生成、队列、作品浏览 | 演示交互；尚未接通启动台的真实任务链及结果索引 |

现有五种模板布局：文生图、多图编辑、Gemma 润色文生图、Gemma 润色多图编辑、单独润色提示词。

导入诊断不会把“同为 GGUF”当作模型可互换的依据。没有可靠候选时保持待核实；需要换加载器、改连线或跨模型架构的情况不会仅替换文件名。

## Windows 桌面开发入口（P0 验证中）

需要 Node.js **22.12 或更新版本**。Electron **44.4.3** 已固定为 npm 开发依赖，锁文件随仓库维护。在项目根目录执行：

```powershell
npm ci
npm run desktop
```

安装依赖后，也可双击 `Start-Desktop.cmd` 打开独立应用窗口。目前是开发运行方式，尚不提供安装包。

P0 连接已运行的本机 ComfyUI，默认路径为 `D:/agent/ComfyUI`，地址为 `http://127.0.0.1:8188/`。请先使用已有启动脚本启动服务，再在桌面窗口中选择“连接已有服务”。需要改变本机配置时，新建 `desktop/config.local.json`：

```json
{
  "comfyRoot": "D:/agent/ComfyUI",
  "comfyUrl": "http://127.0.0.1:8188/"
}
```

配置后重启应用；P0 仅接受本机 HTTP 根地址。配置文件与 `.local/` 数据均已排除在 Git 之外。

- 桌面草稿位于 `.local/desktop-workspace.json`，关闭标签的恢复副本位于 `.local/closed-workflows/`。
- JSON 导出默认目录和 ComfyUI 网页下载目录为 `.local/exports/`；实际落盘及重新导入属于 UI 验收项目。
- 桌面验证目前接收含 `nodes` 的可视工作流，单图上限 8 MB，最多 20 个标签；API 图转成可视图尚未接入。
- 基础参数表单读取同一张真实图；不支持的控件仍在节点画布编辑。官方 App Mode 需要工作流先配置输入和输出。
- P0 不自动启停 ComfyUI／LM Studio。关闭窗口会保存草稿并退出应用，保存失败保留窗口；托盘及统一服务控制安排在 P1。

桌面入口不代表原 A 测中的资源、作品、更新、队列等页面已经接入真实后端。具体结构、限制与待完成验收见 [P0 桌面接入验证](./docs/research/P0桌面接入验证.md)。

## 原 A 测 WebUI 预览

原预览入口继续保留。单独查看 A 测页面不需要 npm 依赖，也不需要下载 ComfyUI 或任何模型。

### Windows 双击

运行根目录下的 `Start-Preview.cmd`。脚本优先使用用户目录中的 Python 3.11；找不到时直接打开 `index.html`。

### 使用 Python 启动

已在 Python 3.11 上验证。从仓库根目录执行：

```powershell
python preview.py --open
```

然后访问 [本地预览](http://127.0.0.1:8840/)。服务只监听本机；已有同一预览时会复用。若端口被其他程序占用，`--open` 会改为打开本地 HTML，不会停止占用端口的程序。

不需要打开浏览器时省略 `--open`。桌面验证窗口也保留“查看 A 测界面”入口；两者的演示边界相同。

## A 测预览边界

- 不启动或停止 ComfyUI／LM Studio，不真实生成、润色、安装、更新或导出图片。
- JSON 诊断及工作副本修改是真实逻辑，但本机清单是开发环境快照，不代表当前设备实时检测，也不保证模型实际可运行。
- 模板入口、资源清单和示例路径来自既有开发环境，不能视为其他设备已安装相同资源。
- 导入最大 2 MB，每次结构预览最多展示 120 个节点；支持定位子图。
- 草稿保存在当前浏览器本地存储。新上传图片使用内存引用，仅本次会话有效。
- 原工作流文件不会因预览替换而改写；导出窗口可复制 JSON。当前内嵌浏览器的下载落盘尚未完成验证。
- 本仓库不分发模型权重、ComfyUI、LM Studio、用户凭据或完整运行环境。

## 开发与测试

页面直接加载 JavaScript／CSS，无前端构建步骤。自动化测试使用 Node.js 内置测试运行器，覆盖 JSON 解析、兼容性诊断、ComfyUI 桥接与桌面工作副本；Electron 是桌面运行所需的开发依赖。

```powershell
npm test
```

也可直接执行：

```powershell
node --test tests/workflow-import.test.cjs tests/compatibility.test.cjs tests/comfy-bridge-source.test.cjs tests/workspace-store.test.cjs
```

默认不要求本机安装 ComfyUI；涉及实际工作流目录的集成检查会明确跳过。需要执行该可选检查时，设置实际目录：

```powershell
$env:COMFYUI_WORKFLOWS_DIR = 'D:\agent\ComfyUI\user\default\workflows'
npm test
```

这个检查只读取 JSON，不启动绘图服务；结果与当前模型清单快照有关。

部署基线工具另有 **7 项 Python 临时目录测试**，覆盖指定文件备份、重复执行不覆盖，以及源文件变化／备份篡改识别：

```powershell
python -m unittest discover -s tests -p test_p0_baseline.py -v
```

在目标设备上可选执行保护文件快照与复核：

```powershell
python tools/p0_baseline.py --comfy-root D:/agent/ComfyUI
python tools/p0_baseline.py --verify
```

基线默认保存在 `.local/p0-baseline/`，不复制模型、不改动 ComfyUI。已有基线不会被重复运行覆盖。

自动测试不代替桌面操作验收。A 测操作记录见[验收记录](./验收记录.md)，桌面实际证据与待验证项见 [P0 桌面接入验证](./docs/research/P0桌面接入验证.md)。

## 开发排期

进展在 [排期总览 #1](https://github.com/TIPSONG/yingzuo/issues/1) 和 [GitHub Issues](https://github.com/TIPSONG/yingzuo/issues) 中跟踪；各阶段写明依赖、任务和验收条件。三个交付节点见 [Milestones](https://github.com/TIPSONG/yingzuo/milestones)。

| 阶段 | 内容 | 估算有效开发日 |
| --- | --- | --- |
| P0 | 桌面接入预研、真实画布与工作流状态验证 | 1–2 |
| P1 | 独立桌面应用开发版、服务控制、托盘、基础设置 | 3–4 |
| P2 | 五个真实工作流、双模式、Gemma、串行队列 | 5–7 |
| P3 | 真实作品库、文件定位和两种导出 | 3–4 |
| P4 | 模板版本、自定义表单、本地资源、实时诊断、收藏板 | 4–6 |
| P5 | Hugging Face／Civitai、下载、插件和在线模板 | 4–6 |
| P6 | 高级批量、任务恢复、更新备份与回滚 | 4–6 |
| P7 | 自然操作回归、Windows 打包和交付 | 2–3 |

日常可用版预计在 P3 后交付，约 12–17 个有效开发日；完整计划为 26–38 日，另留 5–7 日缓冲。均为估算，P0 后重新评估；不是日历日期承诺。

## 目录

```text
index.html / app.js / style.css    页面、状态和交互
workspace-tabs.*                   多标签和独立草稿
workflow-start.*                   新建入口与结构预览
workflow-import.js                 JSON 解析与校验
compatibility*.js / .css           导入诊断、候选与修复
assets/                           A 测示例图片及标识
desktop/                          Electron 主进程、桥接、工作区与验证界面
tests/                            解析、兼容性、桥接、草稿和部署基线测试
tools/snapshot_compatibility.py    开发环境清单快照工具
tools/p0_baseline.py               原部署保护文件及版本基线
preview.py / Start-Preview.cmd     本机预览入口
Start-Desktop.cmd                  Windows 桌面开发入口
docs/                             产品规格、预览说明和既有环境说明
```

`snapshot_compatibility.py` 目前使用开发设备的固定路径，维护其他环境时需先调整路径；它只读取文件名和 Python AST，不导入或运行插件。`p0_baseline.py` 则支持通过参数指定 ComfyUI 与备份目录。

## 项目资料

- [项目总结与后续排期](./项目总结与后续排期.md)
- [产品规格](./docs/产品规格.md)
- [验收记录](./验收记录.md)
- [P0 桌面接入验证与后续建议](./docs/research/P0桌面接入验证.md)
- [桌面容器选型调查](./docs/research/desktop-options.md)
- [A 测预览详细说明](./docs/A测预览说明.md)
- [既有 Gemma 集成说明](./docs/Gemma集成说明.md)
- [早期讨论与实施记录](./docs/历史实施计划.md)

产品范围以规格为准，实际完成情况以验收记录为准，后续进展以 Issues 为准。既有环境说明中的本机路径用于追溯部署，不作为通用安装教程。
