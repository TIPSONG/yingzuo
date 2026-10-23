# Grovebot 开发进度

本文件记录 82 项程序任务的程序实现状态。原任务表由 `node tools/progress.cjs render` 根据 `tasks.json` 生成，审阅表由 `node tools/pr11.cjs render` 根据 `pr11-status.json` 生成；请改 JSON 后重新生成，不要手改表格。当前程序状态与指定提交的自动验证索引见[当前状态与验证证据](./当前状态与验证证据.md)（2026-10-23 核对）。

- 开发分支：`feat/grovebot-impl`（基于 `feat/p0-desktop-integration`）。
- 起点核对（2026-10-13）：计划书写的 HEAD 为 `c8ce1ba`，实际远端分支 HEAD 为 `31d8d2b`（其后多了 `adcfc7c`、`31d8d2b` 两个 P0 加固提交），本分支从 `31d8d2b` 开始。
- Grovebot 初始开发环境（历史）：Linux 容器（无 Windows、无 ComfyUI、无 LM Studio、无 GPU），Node 22.20.0。后续 Codex 修复与 Windows CI 的证据另见上述索引。
- 状态含义：未开始／实现中／程序完成／有限支持／阻塞。“程序完成”= 代码已实现并接入、本机能跑的自动检查通过；“有限支持”= 已实现明确范围，但仍有契约或范围限制。凡依赖真实 Windows/ComfyUI/LM Studio 的部分一律列入《待Codex验收.md》。
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
| D03 | P1 | 异步流程重读当前标签，A 的结果用到 B | 程序完成 | fdbe85a | ui-tasks.test（真实 tasks.js 在 vm 中）：润色中切 A→B、A 修改、A 关闭、批量弹窗中切图；task-service.test：显式 tabId/expectedRevision | 主进程不回退到活动标签；版本不一致时选择使用原标签最新内容或取消。后续 PR11-R10／S07 已接入固定 templateVersionId 和对应表单。 |
| D04 | P1 | 自定义表单未进入正式创作 | 程序完成 | 667ec2d | form-targets.test、task-service.test S07/D04、ui-tasks.test S07、workbench.test | 左侧正式参数面板按已保存表单（中文名/分组/顺序/约束）显示，修改经桥接写回同一 UI 根图；运行按钮=Ctrl+Enter，批量/润色从同一图编译；标签固定 templateVersionId，表单按该版本读取，存为模板后改固定到新版本；子图共享实例不单独编辑。独立副本不带模板绑定（不显示表单） |
| D05 | P1 | 维护失败仍启动服务、继续队列 | 程序完成 | ea187ce | maint.test：恢复失败不 start/不释放租约；task-service.test：维护租约不解除用户暂停、waitForIdle 超时 | 队列改为租约计数；restore-failed 后新维护被拒绝，直到受保护恢复成功才释放 |
| D06 | P1 | 继续恢复绕开运行保护 | 程序完成 | 0fd23ab | maint-service.test D06 | 资源与维护页显示恢复失败暂停状态；maintenance.hold 事件全局提示 |
| D07 | P1 | 补丁冲突仍记成功 | 程序完成 | dad09fb | maint-service.test U06 冲突阻止、R03 未跟踪文件 | 默认策略：冲突在切换前阻止（环境不变）；未提供 needs-resolution 停留模式；Python 模块检查需计划提供 checkModules |
| D08 | P1 | 启动恢复没有持续跟踪存量任务 | 程序完成 | bf765ab | queue.test R12/D08 |  |
| D09 | P1 | 取消后退出 15 秒超时当作可退出 | 程序完成 | 0fd23ab | quit-flow.test（4 项） | 退出流程抽到 desktop/services/quit-flow.cjs |
| D10 | P1 | 目标中断未探测，可能中断下一项 | 程序完成 | 0fd23ab | queue.test D10 两项 | GET /api/jobs 探测；支持时用 /api/jobs/{id}/cancel（服务端原子）；旧后端发送前再核对，仍非原子 |
| D11 | P1 | 服务归属与停止确认不严格 | 程序完成 | d5c41b1 | services.test D11 两项 | LM Studio 无可查询的实例标识，采用“本次应用会话 + 端口 + 就绪确认”的保守归属；跨重启一律按外部 |
| D12 | P1 | 模型移动未与任务/维护互斥 | 程序完成 | c2effab | maint-service.test R08/D12、R06 启动核对 | 环境锁+暂停租约+持锁后再核对；跨盘 journal 与启动核对。外部客户端是否加载模型只能以外部 ComfyUI 运行与否保守判断 |
| D13 | P2 | 分享 JPEG 元数据未遍历完整容器 | 程序完成 | 50c8fa9 | review2 image-meta-jpeg.test（6 项） | 由 feat/grovebot-review2 完成并已合并；方向非 1 时拒绝无损剥离（不做像素旋转） |
| D14 | P2 | 206 续传未核对旧文件身份 | 程序完成 | 50c8fa9 | review2 downloader-resume.test（7 项） | 由 feat/grovebot-review2 完成并已合并 |
| D15 | P1 | 任务快照未隔离敏感输入 | 程序完成 | 5729991 | task-service.test R18 两项；review2 的 secret-fields.test | 敏感字段进入系统加密凭据，快照保留占位符；后续 C01、RV03、RR01–RR04 覆盖草稿／模板／导出／表单及旧数据迁移，映射不明确时阻止相关保存、导出或备份。 |

### 后续程序任务

| 编号 | 级别 | 名称 | 状态 | 提交 | 回归检查 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| PR11-R01 | P1 | 维护状态与暂停租约 | 程序完成 | ea187ce | maint.test：恢复失败不 start/不释放租约；task-service.test：维护租约不解除用户暂停、waitForIdle 超时 | 队列改为租约计数；restore-failed 后新维护被拒绝，直到受保护恢复成功才释放 |
| PR11-R02 | P1 | 首次/继续恢复走同一保护入口 | 程序完成 | 0fd23ab | maint-service.test D06 | 资源与维护页显示恢复失败暂停状态；maintenance.hold 事件全局提示 |
| PR11-R03 | P1 | 补丁冲突不记为成功更新 | 程序完成 | dad09fb | maint-service.test U06 冲突阻止、R03 未跟踪文件 | 默认策略：冲突在切换前阻止（环境不变）；未提供 needs-resolution 停留模式；Python 模块检查需计划提供 checkModules |
| PR11-R04 | P1 | 服务归属与停止闭环 | 程序完成 | d5c41b1 | services.test D11 两项 | LM Studio 无可查询的实例标识，采用“本次应用会话 + 端口 + 就绪确认”的保守归属；跨重启一律按外部 |
| PR11-R05 | P1 | 取消、退出和精确中断 | 程序完成 | 0fd23ab | quit-flow.test、queue.test D10 | 取消退出超时不当作成功（D09，quit-flow.test）；按任务取消接口探测与使用（D10，queue.test） |
| PR11-R06 | P1 | 模型移动与环境操作共用锁 | 程序完成 | c2effab | maint-service.test R08/D12、R06 启动核对 | 环境锁+暂停租约+持锁后再核对；跨盘 journal 与启动核对。外部客户端是否加载模型只能以外部 ComfyUI 运行与否保守判断 |
| PR11-R07 | P1 | 真实五图适配和脱敏契约夹具 | 程序完成 | b689b9d | bindings-real.test（10 项）+ 夹具 tests/fixtures/qwen21-gemma-api.json | 夹具是脱敏构造，不是真实 ComfyUI 编译结果；SaveImageAdvanced 动态子项在 API 中的键名需 Codex 用真实 object_info 只读确认 |
| PR11-R08 | P1 | Gemma 原文连线与采用结果 | 程序完成 | fdbe85a | bindings-real.test | 读取图中 context_length/release_vram/disable_thinking/model/URL；上下文以节点值为准；重新润色改 cache_buster |
| PR11-R09 | P1 | 异步 UI 固定发起标签和版本 | 程序完成 | fdbe85a | ui-tasks.test（真实 tasks.js 在 vm 中）：润色中切 A→B、A 修改、A 关闭、批量弹窗中切图；task-service.test：显式 tabId/expectedRevision | 主进程不回退到活动标签；版本不一致时选择使用原标签最新内容或取消。后续 PR11-R10／S07 已接入固定 templateVersionId 和对应表单。 |
| PR11-R10 | P1 | 自定义表单进入创作和运行 | 程序完成 | 667ec2d | form-targets.test、task-service.test S07/D04、ui-tasks.test S07、workbench.test | 左侧正式参数面板按已保存表单（中文名/分组/顺序/约束）显示，修改经桥接写回同一 UI 根图；运行按钮=Ctrl+Enter，批量/润色从同一图编译；标签固定 templateVersionId，表单按该版本读取，存为模板后改固定到新版本；子图共享实例不单独编辑。独立副本不带模板绑定（不显示表单） |
| PR11-R11 | P1 | 参考图关系进工作区仓库 | 程序完成 | bf2ef3a | graph-package.test×2、task-service.test S08、app-backup.test | 包=UI 图+模板/表单版本+槽位/内容ID/sha256/素材本体；导入先整体校验再写入、分配新标签；缺失素材如实列出；关闭归档写 meta（标题/模板版本），“最近关闭”可重开并带回关系；应用备份含 reference-relations.json、task-submissions 与 references |
| PR11-R12 | P1 | 启动恢复持续跟踪与提交快照 | 程序完成 | a38e080 | queue.test R12/D08；task-service.test R12（未知重试确认、提交记录） | 提交记录保存在 task-submissions/，每次尝试追加，只含凭据占位符 |
| PR11-R13 | P1 | 环境备份与应用数据备份分开 | 程序完成 | 1a66ac2 | app-backup.test | 资源页“应用数据备份”；恢复在 entry.cjs 中、main.cjs 打开数据库前执行；收藏 manifest 在数据库中。真实空间需求预估未做（按实际复制） |
| PR11-R14 | P2 | 回收区与备份空间管理 | 程序完成 | ca3792f | maint-service.test R07/R14；review2 trash-store.test | 只管理本应用登记条目；永久清理需确认、逐项再核对；未完成恢复使用的条目受保护 |
| PR11-R15 | P2 | 206 续传与来源身份 | 程序完成 | 50c8fa9 | review2 downloader-resume.test（7 项） | 由 feat/grovebot-review2 完成并已合并 |
| PR11-R16 | P2 | 分享 JPEG 完整解析和方向策略 | 程序完成 | 50c8fa9 | review2 image-meta-jpeg.test（6 项） | 由 feat/grovebot-review2 完成并已合并；方向非 1 时拒绝无损剥离（不做像素旋转） |
| PR11-R17 | P2 | 大文件工作移出主进程 | 程序完成 | 372d900 | worker-pool.test S09×2、Windows 打包自检 worker 步骤 | 扫描元数据、缩略图、较大文件复制使用共享 WorkerPool；后续 C08 补齐单文件输出关联及收藏复制，RV10 登记临时路径并在 worker 真实退出后清理。并发 2；Windows 文件句柄释放仍待真机验收。 |
| PR11-R18 | P1 | 敏感输入引用与快照脱敏 | 程序完成 | 5729991 | task-service.test R18 两项；review2 的 secret-fields.test | 敏感字段进入系统加密凭据，快照保留占位符；后续 C01、RV03、RR01–RR04 覆盖草稿／模板／导出／表单及旧数据迁移，映射不明确时阻止相关保存、导出或备份。 |
| PR11-R19 | P2 | 批量参数变化与原子规划 | 程序完成 | 8e62ff0 | task-service.test R19；review2 batch-plan.test | 批量全量规划后单事务登记；后续 RV07／RR06 对最终图、枚举与固定表单约束统一校验，无效项整组不入队。 |
| PR11-R20 | P2 | 稳定输出身份与真实保存节点适配 | 程序完成 | eebced9 | task-service.test A03/R20；review2 output-plan.test | 无模板时用结构指纹；SaveImageAdvanced 仅在 object_info 确认 STRING 前缀字段时改写 |
| PR11-R21 | P1 | 真实契约检查与 CI 业务初始化 | 程序完成 | 6854580 | entry.test（单实例先于主进程）；Windows CI 业务初始化检查 run 38377869166 通过（隔离数据根，126 个接口） | CI 无真实 ComfyUI/LM Studio，相关仍为替身测试 |
| PR11-R22 | P2 | 功能闭环复核与交接 | 程序完成 |  |  | 复核 82 项与 PR11 状态，更新 README/待Codex验收/交接与 PR 描述 |

### 第二轮审阅发现（PR11第二轮代码审阅与收尾计划.md，审阅 head 68f7598）

| 编号 | 级别 | 名称 | 状态 | 提交 | 回归检查 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| N01 | P1 | 暂停租约在异步等待期间生效，pump 仍能开始任务 | 程序完成 | d79d15a | queue.test S01×3（ready/后端 queue/GPU 锁三个等待点） | starting 计数纳入 in-flight；每个 await 后重检租约/暂停/任务状态；取得 GPU 锁后同步进入 preparing |
| N02 | P1 | 维护阻断只在内存，且未核对 owned 后端中的外部任务 | 程序完成 | e68442a,010eb41 | maint-service.test S02×2 | maintenance-holds.json 持久化，启动重建租约；仅恢复对应备份解除；无备份的阻断需确认；owned 后端有外部任务或核对失败时阻止；阻断期间 startComfy 拒绝 |
| N03 | P1 | 旧版中断仍有竞态 | 程序完成 | d79d15a | queue.test S03、Q07 | 旧后端运行中默认不发中断（UNSUPPORTED）；全局中断须用户在确认框中明确选择；原子 job 取消保留 |
| N04 | P1 | 模型移动恢复会删掉源路径的新内容 | 程序完成 | d79d15a | maint-service.test S04×3、R06 | 删源前重算源 hash；源变化标冲突两份保留；源缺失只有完整临时副本时补完；路径校验；取环境锁与租约，有任务则推迟 |
| N05 | P1 | 快捷使用路径绕过敏感快照处理 | 程序完成 | b816ee1 | task-service.test S05×2（快捷使用/批量/模板/导出 + 静态扫描） | submissions 唯一提交入口；模板保存转入系统加密存储、导出清空占位。限制：工作区草稿自动保存仍按 ComfyUI 原样保存图（含用户填的 key） |
| N06 | P1 | 应用备份/恢复缺少跨文件一致性与失败启动隔离 | 程序完成 | e1348c8 | app-backup.test S06×3 | 数据库先 VACUUM INTO 再复制只增目录，包内核对引用闭包；失败进入恢复模式（继续同一 journal/回退）；环境备份按登记目录排除、拒绝重叠。写入屏障=暂停提交+编辑器串行队列 |

### 第二轮收尾任务

| 编号 | 级别 | 名称 | 状态 | 提交 | 回归检查 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| S01 | P1 | 真正的提交屏障 | 程序完成 | d79d15a | queue.test S01×3（ready/后端 queue/GPU 锁三个等待点） | starting 计数纳入 in-flight；每个 await 后重检租约/暂停/任务状态；取得 GPU 锁后同步进入 preparing |
| S02 | P1 | 持久化且绑定范围的恢复阻断 | 程序完成 | e68442a,010eb41 | maint-service.test S02×2 | maintenance-holds.json 持久化，启动重建租约；仅恢复对应备份解除；无备份的阻断需确认；owned 后端有外部任务或核对失败时阻止；阻断期间 startComfy 拒绝 |
| S03 | P1 | 旧后端取消能力的明确边界 | 程序完成 | d79d15a | queue.test S03、Q07 | 旧后端运行中默认不发中断（UNSUPPORTED）；全局中断须用户在确认框中明确选择；原子 job 取消保留 |
| S04 | P1 | 模型移动启动恢复保护 | 程序完成 | d79d15a | maint-service.test S04×3、R06 | 删源前重算源 hash；源变化标冲突两份保留；源缺失只有完整临时副本时补完；路径校验；取环境锁与租约，有任务则推迟 |
| S05 | P1 | 统一的提交与存储政策 | 程序完成 | b816ee1 | task-service.test S05×2（快捷使用/批量/模板/导出 + 静态扫描） | submissions 唯一提交入口；模板保存转入系统加密存储、导出清空占位。限制：工作区草稿自动保存仍按 ComfyUI 原样保存图（含用户填的 key） |
| S06 | P1 | 可恢复的一致数据包 | 程序完成 | e1348c8 | app-backup.test S06×3 | 数据库先 VACUUM INTO 再复制只增目录，包内核对引用闭包；失败进入恢复模式（继续同一 journal/回退）；环境备份按登记目录排除、拒绝重叠。写入屏障=暂停提交+编辑器串行队列 |
| S07 | P1 | 完成 D04 的所有入口与版本身份 | 程序完成 | 667ec2d | form-targets.test、task-service.test S07/D04、ui-tasks.test S07、workbench.test | 左侧正式参数面板按已保存表单（中文名/分组/顺序/约束）显示，修改经桥接写回同一 UI 根图；运行按钮=Ctrl+Enter，批量/润色从同一图编译；标签固定 templateVersionId，表单按该版本读取，存为模板后改固定到新版本；子图共享实例不单独编辑。独立副本不带模板绑定（不显示表单） |
| S08 | P1 | 完成参考素材 manifest 与恢复闭包 | 程序完成 | bf2ef3a | graph-package.test×2、task-service.test S08、app-backup.test | 包=UI 图+模板/表单版本+槽位/内容ID/sha256/素材本体；导入先整体校验再写入、分配新标签；缺失素材如实列出；关闭归档写 meta（标题/模板版本），“最近关闭”可重开并带回关系；应用备份含 reference-relations.json、task-submissions 与 references |
| S09 | P2 | 完成 Worker 接入与生命周期 | 程序完成 | 372d900 | worker-pool.test S09×2、Windows 打包自检 worker 步骤 | 扫描/监视元数据走 worker（只回传小结果、读取上限 200MB）；缩略图在 worker 中由 sharp 生成，限制像素与大小、同键去重、tmp→原子改名、源变化丢弃；模型移动与备份中≥16MB 文件流式复制在 worker；共享池并发 2，退出 closeShared。单文件任务输出关联仍同步读取（有上限）；收藏复制图片仍同步 |
| S10 | P2 | 完整收尾与事实一致的交接 | 程序完成 | ff3604e | online.test O07/S10、task-service.test T01；npm run check | T01 缩略图、O07 在线模板库、T03 完成；E07/S04 有限支持（外部契约交 Codex）、R06 范围说明；交接/待验收/README 统一为当前状态（旧“82 项全部完成”标为历史） |

### 第三轮收尾任务（PR11第三轮代码审阅与最终收尾计划.md，审阅 head f493fce）

| 编号 | 级别 | 名称 | 状态 | 提交 | 回归检查 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| C01 | P0 | 工作流图密钥：存储/导出统一策略与启动迁移 | 程序完成 | 990ce24 | graph-storage-policy.test；desktop-main C01 e2e | 草稿自动保存、关闭归档、模板版本、诊断/模板导出均脱敏；启动迁移覆盖历史数据并写 migrations/secret-scan.json；无 object_info 时识别为启发式（有限） |
| C02 | P0 | 维护事务：锁内门禁、先暂停后检查、write-ahead 阶段 | 程序完成 | 035c9a1 | maint.test / maint-service.test | 启动按事务记录恢复 hold；plan/backup/staging 中断标记 cancelled |
| C03 | P0 | 恢复保护：guardedRestore 顺序与 hold 保留 | 程序完成 | 035c9a1 | maint-service.test | 恢复失败保留 hold；被 hold 引用的备份不可清理 |
| C04 | P0 | 应用恢复回滚可重入与恢复模式窗口 | 程序完成 | cfeeeeb | maint.test / entry.test | 回滚冲突即停；标记损坏时按 journal 重建；进入独立恢复窗口 |
| C05 | P1 | 模型移动：空闲+服务检查、无覆盖提交、源变化冲突 | 程序完成 | 035c9a1 | maint-service.test | 临时文件哈希不符时报 needs-attention，不删除 |
| C06 | P1 | 表单版本固定与字段约束 | 程序完成 | 34c1738 | task-service / workbench / templates / desktop-main | applyFormField 带 revision；运行/批量/增强前校验；标签复制保留模板/表单绑定 |
| C07 | P1 | 图包导入导出（worker、子图槽位、模板落地、回滚） | 程序完成 | b78acd4 | graph-package / task-service C07 | 离线时槽位输入仅标记“未验证”（有限）；setTemplateVersion 失败时本地模板条目可能残留 |
| C08 | P1 | WorkerPool 关闭收尾；任务输出关联/收藏复制走 worker | 程序完成 | feab742 | worker-pool.test C08 ×3；assets.test C08 | 主进程只写数据库 |
| C09 | P2 | 交接/验收文档与 CI 记录收口 | 程序完成 | 见交接文档 | — | 范围在本轮后冻结 |

### 代码与截图审阅（PR11代码与截图审阅-d5cca17.md，审阅 head d5cca17；人工验收栏由验收方填写）

| 编号 | 级别 | 名称 | 状态 | 提交 | 回归检查 | 说明 | 人工验收 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RV01 | P1 | 脱敏草稿与索引哈希不一致 | 程序完成 | 0766956 | review-rv01.test：保存→重启读取、旧索引受控修复、篡改仍拒绝 | graphHash 对落盘（已脱敏）图计算；旧索引仅当“解析占位符后哈希等于旧值”时修复 |  |
| RV02 | P1 | forceInput 计入 widget 序列 | 程序完成 | 0766956 | review-rv02.test：forceInput/连线输入、数量不一致、导出 uncertain | forceInput/rawLink 不占 widget 位；object_info 落盘缓存并预热。后续 RR02 对不确定敏感位置阻止保存／导出，不仅提示。 |  |
| RV03 | P1 | 任务 UI 快照残留节点密钥 | 程序完成 | f926325 | review-rv03.test：UI 图/表单/参数脱敏、批量与重试、旧快照迁移 | 仓库创建时统一脱敏（snapshot-secrets）；旧快照迁移到新内容地址并事务更新引用；凭据不可用时记录待迁移，备份被阻止 |  |
| RV04 | P1 | HTTP 探测失败当作已停止 | 程序完成 | f85b55b | maint-service.test：unknown 阻止维护/移动/恢复；HTTP 不通的本应用实例先停止 | 三态 confirmed-stopped/running/unknown；端口检查可注入 |  |
| RV05 | P1 | 恢复前 ensureLayout 重建目标目录 | 程序完成 | 0d0faf8 | review-rv05.test：各步中断后启动继续恢复；异常进入恢复模式 | describeLayout 纯函数；startup-restore 只建 migrations/logs |  |
| RV06 | P1 | 停止/释放显存绕过 starting 与外部任务保护 | 程序完成 | 085abfa | review-rv06.test：starting 等待后复核、只有外部任务、队列无法确认、等待期间身份变化、环境锁占用、外部释放需确认、退出不停止、租约与锁释放 | guardedServiceOp：环境锁→暂停提交→等待 starting→锁内核实归属→后端队列核对 |  |
| RV07 | P2 | 覆盖后未校验最终表单值 | 程序完成 | be63709 | review-rv07.test：values 20→99、批量 [20,99] 零入队、params 覆盖、表单值与批量冲突、枚举不存在值、快照记录最终值 | 对最终 prompt 校验表单约束 + 被覆盖输入的节点枚举/范围；快照 form.values 为实际提交值，requestedValues 为表单原值 |  |
| RV08 | P2 | 快捷使用强制传空 references | 程序完成 | 33216c8 | maint-service.test RV08、review-rv07.test RV08：不传 references、确认期间改图拒绝、参考图缺失不入队 | 确认时返回 tabId/revision，运行必须带 expectedRevision |  |
| RV09 | P2 | 模板目录配置未接线 | 程序完成 | 51b18b1 | review-rv09.test：派生路径=仓库路径、旧配置警告、设置页只读 | 选择“禁用并说明固定位置”方案：模板固定在数据目录 templates；暂不支持迁移到其他目录 |  |
| RV10 | P2 | Worker 临时文件未登记 | 程序完成 | a01cd44 | review-rv10.test：真实 copyFile 取消/close/崩溃、图包临时名、启动只清理登记路径、关闭期间不新建共享池 | 主进程分配临时名并写 worker-temps.json；worker 真实退出后清理 |  |
| RV11 | P2 | 浅色导航选中项对比度 1.25:1 | 程序完成 | c204b75 | review-rv11-12.test（静态 token 对比度）+ review-rv13-ui.test（浏览器实测） | 导航/模式/主题卡独立前景 token；浅色实色按钮底改为 --accent-fill，白字 ≥ 4.5:1 |  |
| RV12 | P2 | NASA + 浅色组件配色不完整 | 程序完成 | c204b75 | review-rv11-12.test：NASA 浅色弹窗/任务/空状态/表单对比度 ≥ 4.5、token 成对；浏览器实测 | 补全 NASA 浅色 token（含 body/aside/page-head 渐变），组件统一走 token |  |
| RV13 | P2 | 切外观丢失设置草稿 | 程序完成 | ef69e31 | review-rv13-ui.test：多字段编辑→切主题/皮肤→保存、路径选择/凭据、保存失败恢复、快速切换收敛 | 后续 RR07 处理保存响应晚于新输入的竞争。浏览器回归需 puppeteer-core + Chrome；独立 CI Chrome 作业设置 REQUIRE_BROWSER_TESTS=1，不允许缺浏览器时跳过。 |  |
| RV14 | P2 | queue.maxBatch 无效 | 程序完成 | be63709 | review-rv07.test RV14：预览/规划/整组检查用配置值，上限 3 与 200 | tasks.preview 返回 maxBatch，批量弹窗与提示同步 |  |
| RV15 | P3 | 截图数据/时机不一致 | 程序完成 | 41e1972、e1aa3d6 | 历史 41e1972/e1aa3d6 重拍 40 张；aab1998 的 RR08 重拍 56 张，见 ui-shots/manifest.json 与 review-rr08-ui.test | 14 场景×4 配色；截图异常不得写成功 manifest；sourceFiles 记录实际渲染字节。静态接口替身截图不构成人工验收。 |  |

### Codex 复审修复（aab1998；证据见当前状态与验证证据.md）

| 编号 | 级别 | 名称 | 状态 | 提交 | 回归检查 | 说明 | 人工验收 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RR01 | — | 误登记普通模型名污染导出 | 程序完成 | aab1998 | review-rr-secrets.test：模型名保留、旧占位字段明确才还原 | 普通模型名不猜成凭据；旧密钥字段缺定义时拒绝解密导出。 |  |
| RR02 | — | 不确定敏感字段仍可保存或导出 | 程序完成 | aab1998 | review-rr-secrets.test：短密钥、空格、不确定位置阻止各导出入口 | 敏感字段映射不确定时阻止写入／导出，保留内存草稿并给出可定位原因。 |  |
| RR03 | — | 旧数据迁移和备份检查不完整 | 程序完成 | aab1998 | review-rr03.test：API/UI/表单/孤立文件、损坏与事务失败 | 迁移不完整时拒绝应用备份；保留历史版本与任务引用，不将遗漏检查记作成功。 |  |
| RR04 | — | 表单默认值和旧任务参数残留明文 | 程序完成 | aab1998 | review-rr-secrets.test：默认值独立清理、固定版本、无版本重试拒绝 | 表单默认值与任务参数独立脱敏；旧重试必须使用固定表单版本。 |  |
| RR05 | — | 退出绕过 starting、环境锁和暂停租约 | 程序完成 | aab1998 | review-rr05.test：真实队列 starting、维护锁、延迟关闭、外部后端 | 锁与租约贯穿退出收尾；不能确认任务安全时保留后端服务。 |  |
| RR06 | — | 快捷使用绕过最终值与表单约束 | 程序完成 | aab1998 | review-rr06.test：范围/枚举/失效映射/缺参考图零入队 | 统一提交入口检查最终图、编译定义和固定表单，保留同步 enqueueCompiled 契约。 |  |
| RR07 | — | 迟到保存响应清除新设置草稿 | 程序完成 | aab1998 | review-rr07-ui.test：新输入、连续保存、外观与路径、失败后重试 | 按字段版本确认保存，后续输入保留；连续保存串行执行。 |  |
| RR08 | — | 截图接口和完成判断失真 | 程序完成 | aab1998 | review-rr08-ui.test：延迟/空状态/四主题/资源事件/失败退出 | 真实页面加明确接口替身；异常阻止成功记录；顺带修复资源事件绑定和查看器／标题栏裁切。 |  |

<!-- /PR11 -->

<!-- TABLE -->

统计：程序完成 79 / 有限支持 3 / 实现中 0 / 阻塞 0 / 未开始 0（共 82）。“程序完成”不等于 Codex 验收通过。

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
| S04 | LM Studio 适配 | 有限支持 |  | desktop/services/lmstudio.cjs | services.test.cjs（CLI 替身） | lms ps --json 输出格式按文档假设，解析失败时明确报告而不猜测；服务归属限本次会话+端口+就绪确认——真实 LM Studio 契约交 Codex 核对 |  |
| S05 | 停止与显存 | 程序完成 |  | desktop/services/comfy-process.cjs<br>desktop/services/api.cjs | services.test.cjs：PID 复用不误停 |  |  |
| S06 | 托盘与单实例 | 程序完成 |  | desktop/main.cjs<br>assets/tray-16.png |  | 单实例锁先于数据迁移（entry.cjs，PR11-R21）；托盘需 Windows 实机 |  |
| S07 | 正确退出 | 程序完成 |  | desktop/main.cjs<br>desktop/services/api.cjs | tests/task-service.test.cjs S07 | 退出：等待/取消后退出/返回；取消超时不当作成功（D09，quit-flow.cjs）；按任务取消接口优先（D10） |  |
| S08 | 状态与设置页面接入 | 程序完成 |  | desktop/ui/shell.js |  | 首页服务卡、设置页、日志页接真实接口 |  |

### 批次 2

| 任务 | 名称 | 状态 | 提交 | 主要文件 | 开发检查 | 说明／限制 | Codex验收状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E07 | 五图表单 | 有限支持 |  |  | tests/bindings.test.cjs | 程序按节点类型+连线推断并对官方模板夹具核对；五个本机真实模板需用真实 object_info 核对——交 Codex Windows 验收 |  |
| E08 | 参考图管线 | 程序完成 |  |  | tests/bindings.test.cjs E08 | 内容寻址素材；关系持久化到 reference-relations.json，旧 localStorage 迁移，复制标签复制关系，素材丢失拒绝提交；图包包含素材 manifest／本体，关闭归档和应用备份保留关系（PR11-R11／S08）。 |  |
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
| T01 | 模板仓库 | 程序完成 | 14ef487 | desktop/repositories/template-repo.cjs<br>desktop/ui/templates.js | tests/templates.test.cjs | 缩略图：任务首个成功输出在 worker 内由 sharp 生成 256px PNG，或手动选择；模板库显示（task-service.test T01） |  |
| T02 | 保存与历史 | 程序完成 |  |  | tests/templates.test.cjs | 版本只追加、恢复生成新版本、另存、导出（含 .yingzuo-form.json）；原模板文件只读 |  |
| T03 | 表单编辑器 | 程序完成 | e6d2d80 | shared/form-schema.cjs | tests/templates.test.cjs | 表单编辑器保存；左侧正式参数面板按表单显示并写回画布；运行/快捷键/批量/润色共用同一工作副本；标签固定模板版本（S07） |  |
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
| T08 | 依赖补齐计划 | 程序完成 |  | desktop/services/online/dependency-plan.cjs | tests/dependency.test.cjs | 缺失模型/节点清单、同名文件来源（HF，大小/sha/revision/许可）、用户选择后经统一下载服务；缺失节点给出来源与手动处理说明，用户填写 Git 地址后通过 R07／O08 的受限 Git 事务安装，重启 ComfyUI 后重新检查。 |  |
| R06 | Manager 适配 | 有限支持 | 27e15c4 | desktop/services/online/dependency-plan.cjs | dependency.test：Manager 探测 | 范围明确：插件安装/更新/启用/禁用/移除统一走受限 Git 维护事务（原方案允许）；Manager/cm-cli 只做只读探测，不调用 Manager 安装 |  |
| R07 | 插件操作事务 | 程序完成 | b9e2351 | desktop/maintenance/plugin-ops.cjs<br>desktop/services/maintenance-service.cjs | maint-service.test：https 限制、安装→移除到回收区 | 仅 https 无账号 Git 地址；staging 克隆固定 revision；可选 pip（Python 环境纳入备份）；移除前列出使用者并需确认，移到回收区 |  |
| R08 | 模型位置管理 | 程序完成 | b9e2351 | desktop/services/maintenance-service.cjs | maint-service.test：非登记目录拒绝、移动成功 | 只在同用途已登记目录间移动（相对名不变）；跨盘复制+sha256 校验后切换；有任务运行时拒绝；LM Studio 模型不在范围 |  |
| O01 | 来源接口 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 统一 search/detail/listFiles/resolveDownload/parseLink，内存 TTL 缓存、AbortSignal 取消、429/5xx 退避；联网失败只影响在线页 |  |
| O02 | Hugging Face | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 仓库/固定 revision/具体文件/大小/sha256/许可/gated；Link 头分页；box 上实测搜索+详情+下载 README 成功 |  |
| O03 | Civitai | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 模型/版本/文件/底模/触发词/授权错误/分页；box 上实测搜索成功；下载需用户凭据，需 Codex 验收 |  |
| O04 | 下载规划 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 按用途选 ComfyUI models 子目录或自选目录、空间（保留 1GB）、重名与 .part 提示、Windows 文件名校验 |  |
| O05 | 通用下载器 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 流式 .part、Range/If-Range 续传、并发、取消、退避重试、大小与 sha256、原子改名；本机 HTTP 服务测试 |  |
| O06 | 下载恢复 | 程序完成 |  | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 启动时中断任务置暂停并按 .part 大小续传；源变化从头下载；每次重新解析 URL，令牌不入库 |  |
| O07 | 在线模板导入 | 程序完成 | 5028971 | desktop/services/online | tests/online.test.cjs、tests/downloader.test.cjs | 链接导入 + 在线模板库浏览：官方 Comfy-Org/workflow_templates 索引（样本夹具来自该仓库）、可在设置 onlineTemplates.sources 增加同格式 https 源；搜索/分类/分页、6 小时缓存、离线显示缓存；导入后同一诊断入口（online.test O07/S10） |  |
| O08 | 联合补齐 | 程序完成 | 27e15c4 | desktop/ui/online.js<br>desktop/services/maintenance-service.cjs | maint-service.test（安装路径） | 模型逐项下载+插件按用户填写的 Git 地址逐个经事务安装，逐项报告；装后重新生成计划；插件需重启 ComfyUI 后才被识别 |  |

### 批次 5

| 任务 | 名称 | 状态 | 提交 | 主要文件 | 开发检查 | 说明／限制 | Codex验收状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q10 | 批量与重启恢复 | 程序完成 |  |  | tests/queue.test.cjs、task-service | 批量：提示词×次数×seed×参数变化，全量校验后单事务整组登记（PR11-R19）；重启恢复 ready + 存量任务独立跟踪（PR11-R12） |  |
| U05 | 更新检测与页面 | 程序完成 | 5c7e40a | desktop/services/update-check.cjs<br>desktop/ui/updates.js | update-check.test：频率与渠道 | 渠道 stable/beta（beta 含预发布）、频率 manual/daily/weekly 后台只检测只提示；定时检查不 git fetch |  |
| U06 | Comfy／插件更新 | 程序完成 | b9e2351 | desktop/maintenance/plugin-ops.cjs | maint-service.test：补丁重放成功/冲突列入待处理 | 按 revision 更新；本地补丁先在目标版本临时索引预检，不能重放或未跟踪文件冲突则阻止更新（PR11-R03） |  |
| U07 | 更新记录与保留 | 程序完成 | b9e2351 | desktop/services/maintenance-service.cjs<br>desktop/ui/resources.js | maint-service.test：保留策略 | 备份列表/校验/恢复/继续未完成恢复/维护记录；保留最近 N 份且每来源保留最近完整备份，使用中不清理，清理=移到回收区 |  |
| U08 | 应用版本维护 | 程序完成 |  |  | tests/update-check.test.cjs | 读取 GitHub Releases、显示变更、显式下载并按 SHA256SUMS 校验、打开目录手动安装；未签名、不配自动更新 feed。仓库私有时提示手动流程 |  |

### 批次 6

| 任务 | 名称 | 状态 | 提交 | 主要文件 | 开发检查 | 说明／限制 | Codex验收状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B01 | 正式数据接入清理 | 程序完成 | 5c7e40a | tools/check.cjs<br>desktop/ui | check：假数据/随机数/内联样式扫描 | 正式页面全部接真实接口，服务不可用显示空/错误状态；保留侧栏明确标注的“A 测界面预览”；修正 CSP 拦截的内联样式 |  |
| B02 | 必要开发检查 | 程序完成 | 5c7e40a | tools/check.cjs<br>tests/maint-service.test.cjs | aab1998：npm run check 438 项（437 通过、1 跳过）；浏览器 13/13，Python 7/7；见当前状态与验证证据.md | 新增 UI 接口白名单、元素存在、内联样式（CSP）、假数据扫描；状态机/迁移/任务恢复/下载续传/备份事务均有自动测试 |  |
| B03 | Windows 构建 | 程序完成 | edfb45a | .github/workflows/windows-build.yml<br>desktop/entry.cjs<br>desktop/smoke.cjs | Actions run 38371603344 成功：便携+NSIS 构建，打包自检 ok=true，驱动 better-sqlite3，sharp 可用 | 双击运行、中文路径、安装升级保留数据需 Codex 在真机验收；未签名 |  |
| B04 | 分发与升级脚本 | 程序完成 | edfb45a | tools/build-win.cjs | Actions 产物含 artifacts.json/SHA256SUMS.txt/smoke-result.json | 版本号取 package.json；如实写未签名；升级不覆盖 userData（安装版 %APPDATA%\映作\data，便携 data\） |  |
| B05 | 程序交付记录 | 程序完成 |  | docs/development/交付记录.md<br>README.md | 文档 | README 更新当前能力；交付记录含阶段提交、依赖、迁移、构建命令、检查结果与限制 |  |
| B06 | 验收交接材料 | 程序完成 |  | docs/development/待Codex验收.md<br>docs/development/交接-下一个agent.md | 文档 | 待验收清单覆盖全部需要真实环境的功能，人工验收栏全部留空；日志入口与样本数据位置写在清单“通用准备” |  |

