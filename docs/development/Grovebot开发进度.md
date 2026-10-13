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

<!-- TABLE -->

统计：程序完成 48 / 实现中 2 / 阻塞 0 / 未开始 32（共 82）。“程序完成”不等于 Codex 验收通过。

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
| F08 | 开发脚本 | 实现中 |  | package.json<br>tools/check.cjs<br>tools/build-win.cjs<br>.github/workflows/ | npm run check 通过 | check/test/build:win 已有；Windows 构建经 GitHub Actions windows-build.yml 实测，结果见 B03 |  |
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
| E10 | 原生视图行为 | 实现中 |  |  |  | 已有：弹窗/离开创作页隐藏原生视图、Ctrl+Enter 运行、聚焦节点桥接(focus)；未做：图片选择/下载、缩放快捷键统一 |  |
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
| A01 | 输出索引 | 未开始 |  |  |  |  |  |
| A02 | 任务输出关联 | 未开始 |  |  |  |  |  |
| A03 | 日期／工作流输出 | 未开始 |  |  |  |  |  |
| A04 | 缩略图与查看器 | 未开始 |  |  |  |  |  |
| A05 | 文件入口 | 未开始 |  |  |  |  |  |
| A06 | 原图导出 | 未开始 |  |  |  |  |  |
| A07 | 分享副本导出 | 未开始 |  |  |  |  |  |
| A08 | 收藏板 | 未开始 |  |  |  |  |  |
| T01 | 模板仓库 | 程序完成 |  | desktop/repositories/template-repo.cjs<br>desktop/ui/templates.js | tests/templates.test.cjs | 导入/搜索/文件夹/标签/收藏/内置五模板只读导入；缩略图仅仓库方法 setThumbnail，界面未接（无缩略图生成来源） |  |
| T02 | 保存与历史 | 程序完成 |  |  | tests/templates.test.cjs | 版本只追加、恢复生成新版本、另存、导出（含 .yingzuo-form.json）；原模板文件只读 |  |
| T03 | 表单编辑器 | 程序完成 |  | shared/form-schema.cjs | tests/templates.test.cjs | 表单设置弹窗：名称/分组/顺序/范围/添加/移除；与 ParameterBinding schema 共用。参数表单页仍用 P0 画布读取，不读模板 schema |  |
| T04 | 映射失效处理 | 程序完成 |  |  | tests/templates.test.cjs | 删除/改类/缺字段/改连线判失效，候选仅同类型同字段，服务端再校验 |  |
| T05 | 实时诊断清单 | 程序完成 |  | desktop/services/diagnostics-service.cjs | tests/diagnostics.test.cjs | 实时诊断：object_info/模型目录/LM Studio 合并，单独采集时间，离线缓存标注；插件版本号需 R01（maint 分支）提供，当前只列插件模块与节点数 |  |
| T06 | 替代建议 | 程序完成 |  | desktop/services/diagnostics-service.cjs | tests/diagnostics.test.cjs | 沿用 compatibility.js 规则，按用途/格式/加载器/架构给候选；未知保持待核实 |  |
| T07 | 修复与撤销 | 程序完成 |  | desktop/services/diagnostics-service.cjs | tests/diagnostics.test.cjs | 单字段事务（版本号校验）→替换标签图→自动复查；撤销（被改动则拒绝）；导出修复副本。改连线类建议只给说明不提供直接应用 |  |
| R01 | 目录扫描 | 未开始 |  |  |  |  |  |
| R02 | 资源详情 | 未开始 |  |  |  |  |  |
| R03 | 引用索引 | 未开始 |  |  |  |  |  |
| R04 | 快捷使用 | 未开始 |  |  |  |  |  |
| R05 | 插件清单 | 未开始 |  |  |  |  |  |
| U01 | 环境清单 | 未开始 |  |  |  |  |  |
| U02 | 可恢复备份 | 未开始 |  |  |  |  |  |
| U03 | 恢复引擎 | 未开始 |  |  |  |  |  |
| U04 | 维护事务与锁 | 未开始 |  |  |  |  |  |

### 批次 4

| 任务 | 名称 | 状态 | 提交 | 主要文件 | 开发检查 | 说明／限制 | Codex验收状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T08 | 依赖补齐计划 | 未开始 |  |  |  |  |  |
| R06 | Manager 适配 | 未开始 |  |  |  |  |  |
| R07 | 插件操作事务 | 未开始 |  |  |  |  |  |
| R08 | 模型位置管理 | 未开始 |  |  |  |  |  |
| O01 | 来源接口 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 统一 search/detail/listFiles/resolveDownload/parseLink，内存 TTL 缓存、AbortSignal 取消、429/5xx 退避；联网失败只影响在线页 |  |
| O02 | Hugging Face | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 仓库/固定 revision/具体文件/大小/sha256/许可/gated；Link 头分页；box 上实测搜索+详情+下载 README 成功 |  |
| O03 | Civitai | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 模型/版本/文件/底模/触发词/授权错误/分页；box 上实测搜索成功；下载需用户凭据，需 Codex 验收 |  |
| O04 | 下载规划 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 按用途选 ComfyUI models 子目录或自选目录、空间（保留 1GB）、重名与 .part 提示、Windows 文件名校验 |  |
| O05 | 通用下载器 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 流式 .part、Range/If-Range 续传、并发、取消、退避重试、大小与 sha256、原子改名；本机 HTTP 服务测试 |  |
| O06 | 下载恢复 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 启动时中断任务置暂停并按 .part 大小续传；源变化从头下载；每次重新解析 URL，令牌不入库 |  |
| O07 | 在线模板导入 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | HF/GitHub/https JSON 链接 → 校验 UI 格式 → 存模板（作者/许可/revision）+本地缓存；不安装不执行 |  |
| O08 | 联合补齐 | 未开始 |  |  |  |  |  |

### 批次 5

| 任务 | 名称 | 状态 | 提交 | 主要文件 | 开发检查 | 说明／限制 | Codex验收状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q10 | 批量与重启恢复 | 程序完成 |  |  | tests/queue.test.cjs、task-service | 批量弹窗（提示词×次数×seed，上限100）、暂停/继续、重启后未提交默认暂停 |  |
| U05 | 更新检测与页面 | 未开始 |  |  |  |  |  |
| U06 | Comfy／插件更新 | 未开始 |  |  |  |  |  |
| U07 | 更新记录与保留 | 未开始 |  |  |  |  |  |
| U08 | 应用版本维护 | 未开始 |  |  |  |  |  |

### 批次 6

| 任务 | 名称 | 状态 | 提交 | 主要文件 | 开发检查 | 说明／限制 | Codex验收状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B01 | 正式数据接入清理 | 未开始 |  |  |  |  |  |
| B02 | 必要开发检查 | 未开始 |  |  |  |  |  |
| B03 | Windows 构建 | 未开始 |  |  |  |  |  |
| B04 | 分发与升级脚本 | 未开始 |  |  |  |  |  |
| B05 | 程序交付记录 | 未开始 |  |  |  |  |  |
| B06 | 验收交接材料 | 未开始 |  |  |  |  |  |

