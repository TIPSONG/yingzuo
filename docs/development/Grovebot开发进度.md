# Grovebot 开发进度

本文件记录 82 项程序任务的程序实现状态。表格由 `node tools/progress.cjs render` 根据 `docs/development/tasks.json` 生成，请改 JSON 后重新生成，不要手改表格。

- 开发分支：`feat/grovebot-impl`（基于 `feat/p0-desktop-integration`）。
- 起点核对（2026-10-13）：计划书写的 HEAD 为 `c8ce1ba`，实际远端分支 HEAD 为 `31d8d2b`（其后多了 `adcfc7c`、`31d8d2b` 两个 P0 加固提交），本分支从 `31d8d2b` 开始。
- 开发环境：Linux 容器（无 Windows、无 ComfyUI、无 LM Studio、无 GPU）。Node 22.20.0（为满足 engines >=22.12 自行下载）。
- 状态含义：未开始／实现中／程序完成／阻塞。“程序完成”= 代码已实现并接入、本机能跑的自动检查通过；凡依赖真实 Windows/ComfyUI/LM Studio 的部分一律列入《待Codex验收.md》。
- Codex验收状态列保持为空，由 Codex 填写。

## 新增依赖（固定版本）

| 依赖 | 版本 | 用途 | Linux 安装结果 |
| --- | --- | --- | --- |
| better-sqlite3 | 12.11.1 | 任务／作品／资源／下载 SQLite | Node 22 下预编译包安装成功，测试可用 |
| sharp | 0.34.5 | 缩略图、分享副本 | 安装成功，可生成 PNG |
| electron-builder | 26.15.3 | Windows 便携包 + NSIS | 安装成功；Windows 构建见 B03 |
| @electron/rebuild | 4.2.1 | 原生模块按 Electron ABI 重建 | 安装成功 |

<!-- PR11 -->
## PR #11 审阅修复（2026-10-13 起）

来源：`docs/development/PR11代码审阅与下一轮程序计划.md`（审阅 head 47e2e18）。审阅里的任务编号 R01–R22 与原计划的 R01–R08（资源任务）重名，这里统一写作 **PR11-R01…R22**。

### 审阅发现

| 编号 | 级别 | 名称 | 状态 | 提交 | 回归检查 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| D01 | P1 | 真实 Qwen 提示词绑定（TextEncodeQwenImage21） | 程序完成 | fdbe85a | bindings-real.test：Qwen21 两输出槽、SamplerCustomAdvanced、未适配编码器 | 按 ComfyUI nodes_qwen.py 定义适配；旧 CLIP 图继续可用 |
| D02 | P1 | Gemma 原文连线被当成没有可写输入 | 程序完成 | fdbe85a | bindings-real.test：连线原文、仅润色替换原文、采用结果、cache_buster | 原文来源沿连线追踪到 PrimitiveStringMultiline.value；采用时提交副本插入 yz_adopted_text 节点并 enable_llm=false |
| D03 | P1 | 异步流程重读当前标签，A 的结果用到 B | 程序完成 | fdbe85a | ui-tasks.test（真实 tasks.js 在 vm 中）：润色中切 A→B、A 修改、A 关闭、批量弹窗中切图；task-service.test：显式 tabId/expectedRevision | 主进程不再回退到活动标签；版本不一致时用户可选用 A 的最新内容或取消。未记录 templateVersionId（模板版本与表单在 PR11-R10 处理） |
| D04 | P1 | 自定义表单未进入正式创作 | 实现中 | 40fc5b1 | task-service.test：表单映射写入/超范围/失效字段/无表单；ui-tasks.test：按表单运行固定发起标签 | “运行”按钮按已保存表单弹出填写并经 applyForm 写入；快照记录 templateId/versionId/取值。左侧参数面板（workbench.js renderFields）仍枚举全部 widget，批量与润色尚未走表单 |
| D05 | P1 | 维护失败仍启动服务、继续队列 | 程序完成 | ea187ce | maint.test：恢复失败不 start/不释放租约；task-service.test：维护租约不解除用户暂停、waitForIdle 超时 | 队列改为租约计数；restore-failed 后新维护被拒绝，直到受保护恢复成功才释放 |
| D06 | P1 | 继续恢复绕开运行保护 | 实现中 | ea187ce |  | restoreBackup 与 resumeRestore 共用 guardedRestore（锁、外部服务检查、租约、等待空闲、停 owned）；失败保留租约。尚缺针对 resumeRestore 的自动测试与 UI 提示 maintenance.holds |
| D07 | P1 | 补丁冲突仍记成功 | 未开始 |  |  |  |
| D08 | P1 | 启动恢复没有持续跟踪存量任务 | 未开始 |  |  |  |
| D09 | P1 | 取消后退出 15 秒超时当作可退出 | 实现中 | ea187ce |  | 取消后 15 秒未结束改为提示：继续等待/仍然退出（不标记完成）/返回；缺 prepareQuit 自动测试。D10 定向中断探测未开始 |
| D10 | P1 | 目标中断未探测，可能中断下一项 | 未开始 |  |  |  |
| D11 | P1 | 服务归属与停止确认不严格 | 未开始 |  |  |  |
| D12 | P1 | 模型移动未与任务/维护互斥 | 未开始 |  |  |  |
| D13 | P2 | 分享 JPEG 元数据未遍历完整容器 | 未开始 |  |  |  |
| D14 | P2 | 206 续传未核对旧文件身份 | 未开始 |  |  |  |
| D15 | P1 | 任务快照未隔离敏感输入 | 未开始 |  |  |  |

### 后续程序任务

| 编号 | 级别 | 名称 | 状态 | 提交 | 回归检查 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| PR11-R01 | P1 | 维护状态与暂停租约 | 程序完成 | ea187ce | maint.test：恢复失败不 start/不释放租约；task-service.test：维护租约不解除用户暂停、waitForIdle 超时 | 队列改为租约计数；restore-failed 后新维护被拒绝，直到受保护恢复成功才释放 |
| PR11-R02 | P1 | 首次/继续恢复走同一保护入口 | 实现中 | ea187ce |  | restoreBackup 与 resumeRestore 共用 guardedRestore（锁、外部服务检查、租约、等待空闲、停 owned）；失败保留租约。尚缺针对 resumeRestore 的自动测试与 UI 提示 maintenance.holds |
| PR11-R03 | P1 | 补丁冲突不记为成功更新 | 未开始 |  |  |  |
| PR11-R04 | P1 | 服务归属与停止闭环 | 未开始 |  |  |  |
| PR11-R05 | P1 | 取消、退出和精确中断 | 实现中 | 7c097d7 |  | 已做：取消退出超时不当作成功（D09）；未做：定向中断能力探测（D10）、prepareQuit 测试 |
| PR11-R06 | P1 | 模型移动与环境操作共用锁 | 未开始 |  |  |  |
| PR11-R07 | P1 | 真实五图适配和脱敏契约夹具 | 实现中 | fdbe85a | tests/fixtures/qwen21-gemma-api.json 脱敏夹具 | Qwen21/Primitive/Gemma/PreviewAny 已按源码适配；ResolutionSelector、SaveImageAdvanced 输入名未从源码核实（只读处理并标注来源），尚未用 object_info 校验绑定 |
| PR11-R08 | P1 | Gemma 原文连线与采用结果 | 程序完成 | fdbe85a | bindings-real.test | 读取图中 context_length/release_vram/disable_thinking/model/URL；上下文以节点值为准；重新润色改 cache_buster |
| PR11-R09 | P1 | 异步 UI 固定发起标签和版本 | 程序完成 | fdbe85a | ui-tasks.test（真实 tasks.js 在 vm 中）：润色中切 A→B、A 修改、A 关闭、批量弹窗中切图；task-service.test：显式 tabId/expectedRevision | 主进程不再回退到活动标签；版本不一致时用户可选用 A 的最新内容或取消。未记录 templateVersionId（模板版本与表单在 PR11-R10 处理） |
| PR11-R10 | P1 | 自定义表单进入创作和运行 | 实现中 | 40fc5b1 | task-service.test：表单映射写入/超范围/失效字段/无表单；ui-tasks.test：按表单运行固定发起标签 | “运行”按钮按已保存表单弹出填写并经 applyForm 写入；快照记录 templateId/versionId/取值。左侧参数面板（workbench.js renderFields）仍枚举全部 widget，批量与润色尚未走表单 |
| PR11-R11 | P1 | 参考图关系进工作区仓库 | 未开始 |  |  |  |
| PR11-R12 | P1 | 启动恢复持续跟踪与提交快照 | 未开始 |  |  |  |
| PR11-R13 | P1 | 环境备份与应用数据备份分开 | 未开始 |  |  |  |
| PR11-R14 | P2 | 回收区与备份空间管理 | 未开始 |  |  |  |
| PR11-R15 | P2 | 206 续传与来源身份 | 未开始 |  |  |  |
| PR11-R16 | P2 | 分享 JPEG 完整解析和方向策略 | 未开始 |  |  |  |
| PR11-R17 | P2 | 大文件工作移出主进程 | 未开始 |  |  |  |
| PR11-R18 | P1 | 敏感输入引用与快照脱敏 | 未开始 |  |  |  |
| PR11-R19 | P2 | 批量参数变化与原子规划 | 未开始 |  |  |  |
| PR11-R20 | P2 | 稳定输出身份与真实保存节点适配 | 未开始 |  |  |  |
| PR11-R21 | P1 | 真实契约检查与 CI 业务初始化 | 未开始 |  |  |  |
| PR11-R22 | P2 | 功能闭环复核与交接 | 未开始 |  |  |  |

<!-- /PR11 -->

<!-- TABLE -->

统计：程序完成 82 / 实现中 0 / 阻塞 0 / 未开始 0（共 82）。“程序完成”不等于 Codex 验收通过。

### 批次 1

| 任务 | 名称 | 状态 | 提交 | 主要文件 | 开发检查 | 说明／限制 | Codex验收状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F01 | 现状登记 | 程序完成 |  | desktop/services/environment-record.cjs<br>tools/env-record.cjs | npm run check；node tools/env-record.cjs 在 Linux 实跑 | 诊断导出与命令行均可生成；不含凭据。12 文件基线仍由 tools/p0_baseline.py 维护，未改动 |  |
| F02 | 主进程拆分 | 程序完成 |  | desktop/main.cjs<br>desktop/services/editor-session.cjs<br>desktop/services/api.cjs | desktop-main.test.cjs 22 项（mock Electron） | main.cjs 只做组装；原 P0 编辑器逻辑整体移入 editor-session（依赖注入，行为与测试保持） |  |
| F03 | 公共 schema | 程序完成 |  | shared/schema.cjs<br>desktop/core/errors.cjs | foundation.test.cjs | 8 类核心记录、任务状态机、IPC 信封与错误代码 |  |
| F04 | 数据根与迁移 | 程序完成 |  | desktop/repositories/data-root.cjs<br>app.js | foundation.test.cjs：导入、只导入一次、失败回滚 | 安装版 userData/data、便携版 exe 旁 portable.flag→data/、开发 .local/data；A 测草稿走显式导出/导入，blob 参考图计数并提示重选 |  |
| F05 | 存储仓库 | 程序完成 |  | desktop/repositories/database.cjs<br>desktop/core/fs-atomic.cjs<br>desktop/workspace-store.cjs | foundation.test.cjs：两种 SQLite 驱动的迁移/事务/保存点/VACUUM INTO 备份/损坏只读 | better-sqlite3 优先；Electron 未重建时回退 node:sqlite。工作区改为 v2（drafts/ + graphHash + revision） |  |
| F06 | 事件与锁 | 程序完成 |  | desktop/core/locks.cjs<br>desktop/core/events.cjs | foundation.test.cjs |  |  |
| F07 | 凭据与日志 | 程序完成 |  | desktop/core/logger.cjs<br>desktop/core/credentials.cjs | foundation.test.cjs：脱敏、轮转、加密不可用拒绝明文 | Windows DPAPI 实际加密需 Codex 验收 |  |
| F08 | 开发脚本 | 程序完成 |  | package.json<br>tools/check.cjs<br>tools/build-win.cjs<br>.github/workflows/ | GitHub Actions windows-build 运行 38370113540 成功（npm run check + build:win 产出安装包/便携版） | 安装包实际安装、启动、卸载需 Codex 在 Windows 验收；未签名 |  |
| E01 | 版本适配层 | 程序完成 |  | desktop/adapters/comfy-editor-adapter.cjs<br>desktop/comfy-bridge-source.cjs | services.test.cjs、comfy-bridge-source.test.cjs | 能力探测给出具体限制；旧桥接测试全部保留 |  |
| E02 | 正式页面融合 | 程序完成 |  | desktop/workbench.html<br>desktop/ui/shell.js<br>desktop/ui/shell.css | check 语法；无 DOM 自动测试 | 首页优先，节点/表单入口并列，A 测仅保留预览入口；需 Codex 实机看界面 |  |
| E03 | 工作流标签 | 程序完成 |  | desktop/services/editor-session.cjs<br>desktop/workspace-store.cjs | desktop-main.test.cjs、workspace-store.test.cjs | 新增重命名、viewport 持久化、revision；模板标签复用 |  |
| E04 | 新建起始页 | 程序完成 |  | desktop/ui/shell.js |  | 起始页：拖入/选文件/粘贴/模板/空白；需 Codex 实机 |  |
| E05 | 导入管线 | 程序完成 |  | shared/import-pipeline.cjs<br>desktop/services/editor-session.cjs | pipeline 单测见 batch2 补充 | API 格式用前端官方 loadApiJson 转换并核对缺失节点类型，原文件另存 |  |
| E06 | 根图与串写保护 | 程序完成 |  | desktop/services/editor-session.cjs | desktop-main.test.cjs | applyParameters 支持 expectedRevision 拒绝串写 |  |
| S01 | 统一配置 | 程序完成 |  | desktop/repositories/config-repo.cjs | foundation.test.cjs |  |  |
| S02 | 服务探测 | 程序完成 |  | desktop/services/service-probe.cjs | services.test.cjs（本机 HTTP 替身） | 真实 ComfyUI/LM Studio 需 Codex |  |
| S03 | 按需启动 ComfyUI | 程序完成 |  | desktop/services/comfy-process.cjs<br>desktop/services/process-utils.cjs | services.test.cjs | Windows 进程身份查询用 PowerShell Get-CimInstance，未在 Windows 实跑 |  |
| S04 | LM Studio 适配 | 程序完成 |  | desktop/services/lmstudio.cjs | services.test.cjs（CLI 替身） | lms ps --json 输出格式按文档假设，需 Codex 实机核对 |  |
| S05 | 停止与显存 | 程序完成 |  | desktop/services/comfy-process.cjs<br>desktop/services/api.cjs | services.test.cjs：PID 复用不误停 |  |  |
| S06 | 托盘与单实例 | 程序完成 |  | desktop/main.cjs<br>assets/tray-16.png |  | 托盘菜单与单实例；Windows 托盘需实机 |  |
| S07 | 正确退出 | 程序完成 |  | desktop/main.cjs<br>desktop/services/api.cjs | tests/task-service.test.cjs S07 | 退出对话框：等待/取消后退出/返回；暂停提交；真实 Windows 退出需验收 |  |
| S08 | 状态与设置页面接入 | 程序完成 |  | desktop/ui/shell.js |  | 首页服务卡、设置页、日志页接真实接口 |  |

### 批次 2

| 任务 | 名称 | 状态 | 提交 | 主要文件 | 开发检查 | 说明／限制 | Codex验收状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E07 | 五图表单 | 程序完成 |  |  | tests/bindings.test.cjs | 按节点类型+连线推断（提示词/负面/seed/步数/cfg/尺寸/模型/参考图/Gemma），已连线只读；五个真实模板需 Codex 核对 |  |
| E08 | 参考图管线 | 程序完成 |  |  | tests/bindings.test.cjs E08 | data/references 内容寻址；运行栏“参考图…”按 LoadImage 节点选择/移除，按标签保存，运行前上传并写回服务器返回名，重启后重跑自动补传；需真实 ComfyUI 验收 |  |
| E09 | 编译与定位 | 程序完成 |  |  | tests/bindings.test.cjs E09 | compileTab：后台标签切换→graphToPrompt→切回；本地检查 object_info |  |
| E10 | 原生视图行为 | 程序完成 | 27e15c4 | desktop/services/editor-session.cjs<br>desktop/ui/tasks.js | desktop-main.test：快捷键映射 | 弹窗/离开创作页隐藏原生视图；原生视图内 Ctrl+Enter 走映作队列、Ctrl +/-/0 缩放；图片下载保存到 exports 并提示；图片选择用 Comfy 原生文件框；需 Windows 实测 |  |
| Q01 | 任务持久化 | 程序完成 |  |  | tests/queue.test.cjs 13 项（ComfyUI 替身） | 真实 ComfyUI 下的提交/核对/中断需 Codex 验收 |  |
| Q02 | Comfy HTTP/WS 客户端 | 程序完成 |  |  | tests/queue.test.cjs 13 项（ComfyUI 替身） | 真实 ComfyUI 下的提交/核对/中断需 Codex 验收 |  |
| Q03 | 单一串行调度器 | 程序完成 |  |  | tests/queue.test.cjs 13 项（ComfyUI 替身） | 真实 ComfyUI 下的提交/核对/中断需 Codex 验收 |  |
| Q04 | 提交与断连核对 | 程序完成 |  |  | tests/queue.test.cjs 13 项（ComfyUI 替身） | 真实 ComfyUI 下的提交/核对/中断需 Codex 验收 |  |
| Q05 | 真实状态与错误 | 程序完成 |  |  | tests/queue.test.cjs 13 项（ComfyUI 替身） | 真实 ComfyUI 下的提交/核对/中断需 Codex 验收 |  |
| Q06 | 统一运行入口 | 程序完成 |  | desktop/ui/tasks.js<br>desktop/services/task-service.cjs | tests/task-service.test.cjs；box 上 Electron 启动无报错 | 运行栏/Ctrl+Enter/任务队列页；空图与本地检查不通过时拒绝并说明 |  |
| Q07 | 取消与重试 | 程序完成 |  |  | tests/queue.test.cjs 13 项（ComfyUI 替身） | 真实 ComfyUI 下的提交/核对/中断需 Codex 验收 |  |
| Q08 | 手动润色与单独润色 | 程序完成 |  | shared/bindings.cjs | tests/bindings.test.cjs、task-service | 仅润色子图+PreviewAny 读文本，采用后 enable_llm=false；润色节点真实类名/输入名需 Codex 用真实工作流验收 |  |
| Q09 | 自动润色生成 | 程序完成 |  |  | tests/bindings.test.cjs | 执行原图含 Gemma；8192 与 2 张参考图检查；显存提示 |  |

### 批次 3

| 任务 | 名称 | 状态 | 提交 | 主要文件 | 开发检查 | 说明／限制 | Codex验收状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A01 | 输出索引 | 程序完成 |  |  |  | feat/grovebot-assets 合入；详见 进度-assets.md |  |
| A02 | 任务输出关联 | 程序完成 |  |  |  | feat/grovebot-assets 合入；详见 进度-assets.md |  |
| A03 | 日期／工作流输出 | 程序完成 |  |  |  | feat/grovebot-assets 合入；详见 进度-assets.md |  |
| A04 | 缩略图与查看器 | 程序完成 | 5c7e40a | desktop/ui/assets.js | check：接口/元素/内联样式检查 | 作品网格+查看器：滚轮缩放、拖动、0/1/+/-、元数据如实显示缺失项、打开/定位/导出/分享副本/收藏；需 Windows 实测 |  |
| A05 | 文件入口 | 程序完成 |  |  |  | feat/grovebot-assets 合入；详见 进度-assets.md |  |
| A06 | 原图导出 | 程序完成 |  |  |  | feat/grovebot-assets 合入；详见 进度-assets.md |  |
| A07 | 分享副本导出 | 程序完成 |  |  |  | feat/grovebot-assets 合入；详见 进度-assets.md |  |
| A08 | 收藏板 | 程序完成 | 5c7e40a | desktop/ui/assets.js | favorites 单测（assets 分支） | 收藏板按 arrangeAlbum 等高行排列，取消收藏移到回收区；CSP 下位置用 CSSOM 设置 |  |
| T01 | 模板仓库 | 程序完成 |  | desktop/repositories/template-repo.cjs<br>desktop/ui/templates.js | tests/templates.test.cjs | 导入/搜索/文件夹/标签/收藏/内置五模板只读导入；缩略图仅仓库方法 setThumbnail，界面未接（无缩略图生成来源） |  |
| T02 | 保存与历史 | 程序完成 |  |  | tests/templates.test.cjs | 版本只追加、恢复生成新版本、另存、导出（含 .yingzuo-form.json）；原模板文件只读 |  |
| T03 | 表单编辑器 | 程序完成 |  | shared/form-schema.cjs | tests/templates.test.cjs | 表单设置弹窗：名称/分组/顺序/范围/添加/移除；与 ParameterBinding schema 共用。参数表单页仍用 P0 画布读取，不读模板 schema |  |
| T04 | 映射失效处理 | 程序完成 |  |  | tests/templates.test.cjs | 删除/改类/缺字段/改连线判失效，候选仅同类型同字段，服务端再校验 |  |
| T05 | 实时诊断清单 | 程序完成 |  | desktop/services/diagnostics-service.cjs | tests/diagnostics.test.cjs | 实时诊断：object_info/模型目录/LM Studio 合并，单独采集时间，离线缓存标注；插件版本号需 R01（maint 分支）提供，当前只列插件模块与节点数 |  |
| T06 | 替代建议 | 程序完成 |  | desktop/services/diagnostics-service.cjs | tests/diagnostics.test.cjs | 沿用 compatibility.js 规则，按用途/格式/加载器/架构给候选；未知保持待核实 |  |
| T07 | 修复与撤销 | 程序完成 |  | desktop/services/diagnostics-service.cjs | tests/diagnostics.test.cjs | 单字段事务（版本号校验）→替换标签图→自动复查；撤销（被改动则拒绝）；导出修复副本。改连线类建议只给说明不提供直接应用 |  |
| R01 | 目录扫描 | 程序完成 |  |  |  | feat/grovebot-maint 合入；详见 进度-maint.md |  |
| R02 | 资源详情 | 程序完成 |  |  |  | feat/grovebot-maint 合入；详见 进度-maint.md |  |
| R03 | 引用索引 | 程序完成 | b9e2351 | desktop/services/maintenance-service.cjs<br>desktop/ui/resources.js | maint-service.test：草稿+任务快照引用 | 引用索引来自草稿标签、模板当前版本与最近 200 个任务快照；资源页“引用诊断”和详情显示 |  |
| R04 | 快捷使用 | 程序完成 | 5c7e40a | desktop/services/maintenance-service.cjs<br>desktop/ui/resources.js | quick-use 单测（maint 分支） | resources.quickUse：编译当前标签→planQuickUse→确认后 applyPlan 入队，不改原工作流 |  |
| R05 | 插件清单 | 程序完成 |  |  |  | feat/grovebot-maint 合入；详见 进度-maint.md |  |
| U01 | 环境清单 | 程序完成 |  |  |  | feat/grovebot-maint 合入；详见 进度-maint.md |  |
| U02 | 可恢复备份 | 程序完成 |  |  |  | feat/grovebot-maint 合入；详见 进度-maint.md |  |
| U03 | 恢复引擎 | 程序完成 |  |  |  | feat/grovebot-maint 合入；详见 进度-maint.md |  |
| U04 | 维护事务与锁 | 程序完成 | b9e2351 | desktop/services/maintenance-service.cjs | maint-service.test：锁占用阻止、apply 失败自动恢复、env_transactions 记录 | 已接入主进程：环境锁 createLocks().environment、暂停队列等待空闲、只停本应用拥有的 ComfyUI、备份→staging→apply→检查，失败自动恢复 |  |

### 批次 4

| 任务 | 名称 | 状态 | 提交 | 主要文件 | 开发检查 | 说明／限制 | Codex验收状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T08 | 依赖补齐计划 | 程序完成 |  | desktop/services/online/dependency-plan.cjs | tests/dependency.test.cjs | 缺失模型/节点清单、同名文件来源（HF，大小/sha/revision/许可）、用户选择后经统一下载服务；缺节点给手动处理说明（插件安装待 R07） |  |
| R06 | Manager 适配 | 程序完成 | 27e15c4 | desktop/services/online/dependency-plan.cjs | dependency.test：Manager 探测 | 只读探测 Manager/cm-cli；因各版本 CLI/HTTP 不一致不做猜测调用，插件操作统一走受限 Git 事务（规格允许的后备）；不安装另一个 Manager |  |
| R07 | 插件操作事务 | 程序完成 | b9e2351 | desktop/maintenance/plugin-ops.cjs<br>desktop/services/maintenance-service.cjs | maint-service.test：https 限制、安装→移除到回收区 | 仅 https 无账号 Git 地址；staging 克隆固定 revision；可选 pip（Python 环境纳入备份）；移除前列出使用者并需确认，移到回收区 |  |
| R08 | 模型位置管理 | 程序完成 | b9e2351 | desktop/services/maintenance-service.cjs | maint-service.test：非登记目录拒绝、移动成功 | 只在同用途已登记目录间移动（相对名不变）；跨盘复制+sha256 校验后切换；有任务运行时拒绝；LM Studio 模型不在范围 |  |
| O01 | 来源接口 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 统一 search/detail/listFiles/resolveDownload/parseLink，内存 TTL 缓存、AbortSignal 取消、429/5xx 退避；联网失败只影响在线页 |  |
| O02 | Hugging Face | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 仓库/固定 revision/具体文件/大小/sha256/许可/gated；Link 头分页；box 上实测搜索+详情+下载 README 成功 |  |
| O03 | Civitai | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 模型/版本/文件/底模/触发词/授权错误/分页；box 上实测搜索成功；下载需用户凭据，需 Codex 验收 |  |
| O04 | 下载规划 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 按用途选 ComfyUI models 子目录或自选目录、空间（保留 1GB）、重名与 .part 提示、Windows 文件名校验 |  |
| O05 | 通用下载器 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 流式 .part、Range/If-Range 续传、并发、取消、退避重试、大小与 sha256、原子改名；本机 HTTP 服务测试 |  |
| O06 | 下载恢复 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 启动时中断任务置暂停并按 .part 大小续传；源变化从头下载；每次重新解析 URL，令牌不入库 |  |
| O07 | 在线模板导入 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | HF/GitHub/https JSON 链接 → 校验 UI 格式 → 存模板（作者/许可/revision）+本地缓存；不安装不执行 |  |
| O08 | 联合补齐 | 程序完成 | 27e15c4 | desktop/ui/online.js<br>desktop/services/maintenance-service.cjs | maint-service.test（安装路径） | 模型逐项下载+插件按用户填写的 Git 地址逐个经事务安装，逐项报告；装后重新生成计划；插件需重启 ComfyUI 后才被识别 |  |

### 批次 5

| 任务 | 名称 | 状态 | 提交 | 主要文件 | 开发检查 | 说明／限制 | Codex验收状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q10 | 批量与重启恢复 | 程序完成 |  |  | tests/queue.test.cjs、task-service | 批量弹窗（提示词×次数×seed，上限100）、暂停/继续、重启后未提交默认暂停 |  |
| U05 | 更新检测与页面 | 程序完成 | 5c7e40a | desktop/services/update-check.cjs<br>desktop/ui/updates.js | update-check.test：频率与渠道 | 渠道 stable/beta（beta 含预发布）、频率 manual/daily/weekly 后台只检测只提示；定时检查不 git fetch |  |
| U06 | Comfy／插件更新 | 程序完成 | b9e2351 | desktop/maintenance/plugin-ops.cjs | maint-service.test：补丁重放成功/冲突列入待处理 | ComfyUI/插件按指定 revision 更新；本地改动（Gemma 补丁）存补丁文件并 3-way 重放，冲突保留补丁列入待处理；requirements 变化才 pip |  |
| U07 | 更新记录与保留 | 程序完成 | b9e2351 | desktop/services/maintenance-service.cjs<br>desktop/ui/resources.js | maint-service.test：保留策略 | 备份列表/校验/恢复/继续未完成恢复/维护记录；保留最近 N 份且每来源保留最近完整备份，使用中不清理，清理=移到回收区 |  |
| U08 | 应用版本维护 | 程序完成 |  |  | tests/update-check.test.cjs | 读取 GitHub Releases、显示变更、显式下载并按 SHA256SUMS 校验、打开目录手动安装；未签名、不配自动更新 feed。仓库私有时提示手动流程 |  |

### 批次 6

| 任务 | 名称 | 状态 | 提交 | 主要文件 | 开发检查 | 说明／限制 | Codex验收状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B01 | 正式数据接入清理 | 程序完成 | 5c7e40a | tools/check.cjs<br>desktop/ui | check：假数据/随机数/内联样式扫描 | 正式页面全部接真实接口，服务不可用显示空/错误状态；保留侧栏明确标注的“A 测界面预览”；修正 CSP 拦截的内联样式 |  |
| B02 | 必要开发检查 | 程序完成 | 5c7e40a | tools/check.cjs<br>tests/maint-service.test.cjs | npm run check 214 项 | 新增 UI 接口白名单、元素存在、内联样式（CSP）、假数据扫描；状态机/迁移/任务恢复/下载续传/备份事务均有自动测试 |  |
| B03 | Windows 构建 | 程序完成 | edfb45a | .github/workflows/windows-build.yml<br>desktop/entry.cjs<br>desktop/smoke.cjs | Actions run 38371603344 成功：便携+NSIS 构建，打包自检 ok=true，驱动 better-sqlite3，sharp 可用 | 双击运行、中文路径、安装升级保留数据需 Codex 在真机验收；未签名 |  |
| B04 | 分发与升级脚本 | 程序完成 | edfb45a | tools/build-win.cjs | Actions 产物含 artifacts.json/SHA256SUMS.txt/smoke-result.json | 版本号取 package.json；如实写未签名；升级不覆盖 userData（安装版 %APPDATA%\映作\data，便携 data\） |  |
| B05 | 程序交付记录 | 程序完成 |  | docs/development/交付记录.md<br>README.md | 文档 | README 更新当前能力；交付记录含阶段提交、依赖、迁移、构建命令、检查结果与限制 |  |
| B06 | 验收交接材料 | 程序完成 |  | docs/development/待Codex验收.md<br>docs/development/交接-下一个agent.md | 文档 | 待验收清单覆盖全部需要真实环境的功能，人工验收栏全部留空；日志入口与样本数据位置写在清单“通用准备” |  |

