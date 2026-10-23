# 交接：给下一个 agent（Grovebot 实现进度）

文档核对日期：2026-10-23。本文件保留 Grovebot 各轮实现的历史记录；box 上的 `/workspace/yingzuo-handoff.md` 是当时副本，不能替代仓库当前状态。

## 当前交接入口（以此为准）

- 原 82 项：**79 程序完成、3 有限支持、0 实现中**；E07、S04、R06 的范围限制继续保留。状态源为 `tasks.json` 与 `pr11-status.json`，人工验收栏保持空白。
- D04／PR11-R10 左侧自定义表单及润色、PR11-R11 素材 manifest 与恢复、PR11-R17 缩略图 Worker 都已实现；第四轮“仍在做”是历史快照，不是当前待开发清单。
- Codex 已在 `aab1998` 修复 RR01–RR08，并修复资源页按钮绑定、查看器及标题栏裁切。该提交自动验证为 Node 438 项（437 通过、1 跳过）、浏览器 13／13、Python 7／7；Windows 构建与自检通过，静态截图 56 张。这是指定提交的历史验证，本次整理没有重新宣称跑过这些检查。
- 修复文件、回归用例、CI 链接与截图哈希说明统一在[当前状态与验证证据](./当前状态与验证证据.md)。[待验收清单](./待Codex验收.md) 的结果仍留空，静态截图／CI 不代替 Windows + 真实 ComfyUI／LM Studio／GPU 人工验收。
- 新的发布清单修正单独跟踪 [Issue #16](https://github.com/TIPSONG/yingzuo/issues/16)，后续修复应记录自身的提交与验证结果。PR #11 的草稿和不合并边界继续保留。

## Grovebot 历史交接正文（2026-10-13）

以下原环境、轮次、测试数字及“下一步”只描述当时状态。当前事实以上方入口、状态源和证据索引为准，不能据此重复开已完成的开发任务。

## 1. 这是什么

用户 Tenhi 把 Codex 写的《映作：Grovebot 架构设计与完整程序任务》（82 项任务，6 个批次）交给 Grovebot 实现。仓库 `TIPSONG/yingzuo`，基线分支 `feat/p0-desktop-integration`（实际 HEAD `31d8d2b`，不是计划书写的 `c8ce1ba`），工作分支 **`feat/grovebot-impl`**。规则：不合并 PR、不删分支、不 force-push、不碰 main；最多开一个指向 `feat/p0-desktop-integration` 的草稿 PR。

开发环境是 Linux 容器：没有 Windows、ComfyUI、LM Studio、GPU。凡需真实环境的都写进 `docs/development/待Codex验收.md`，任务状态最多到“程序完成”。

## 2. 环境准备（box 上）

```bash
export PATH=~/opt/node22/bin:$PATH   # 自己下载的 Node 22.20（系统 Node 是 20，不满足 engines）
cd /workspace/yingzuo
npm ci                               # better-sqlite3 / sharp 在 Linux 预编译包可装
npm run check                        # 语法 + 白名单 + 全部 node:test
node tools/progress.cjs set F01 程序完成 --commit abc --files a,b --checks "..." --note "..."
node tools/progress.cjs render       # 由 docs/development/tasks.json 生成进度表
```

shell 有 `noclobber`：用 `cat > file` 覆盖已有文件会失败，先 `set +o noclobber`。git 身份已在仓库内配置为 `Grovebot (via TIPSONG)`。

## 3. 架构速览（已落地）

- `desktop/main.cjs`：只做组装（数据根→迁移→配置→日志→编辑器会话→API→托盘→退出）。
- `desktop/services/editor-session.cjs`：原 P0 主进程编辑器逻辑整体搬过来，计时器/fetch/Electron 对象由 main 注入（测试用 vm 跑 main.cjs 并替换这些对象）。旧 IPC 通道 `yingzuo:p0` 仍服务创作页。
- `desktop/services/api.cjs`：新 IPC 通道 `yingzuo:api`，命令 `{requestId, method:'group.name', args}`，分组白名单在 `shared/schema.cjs`，preload 中 `GROUPS` 必须与 api 方法一致（`tools/check.cjs` 会检查）。
- `shared/schema.cjs`：核心记录 schema、任务状态机（unknown 不能直接回 queued）。
- `desktop/core/`：errors、events（序号+间隙检测）、locks（Mutex/串行/取消/超时）、paths（Windows 规则）、fs-atomic、logger（脱敏+轮转）、credentials（safeStorage，不降级明文）。
- `desktop/repositories/`：data-root（安装/便携/开发 + .local 导入）、config-repo（问题清单而不是崩溃）、database（better-sqlite3 → 回退 node:sqlite；迁移只追加）。
- `desktop/workspace-store.cjs`：工作区 v2：`workspace.json` + `drafts/<id>.json` + graphHash + revision。
- `desktop/adapters/comfy-editor-adapter.cjs` + `comfy-bridge-source.cjs`：新增 compile（graphToPrompt）、focus、convertApi（loadApiJson）、viewport。
- UI：`desktop/workbench.html` 变成正式外壳；`desktop/ui/shell.js` 负责首页/起始页/服务日志/设置；`workbench.js` 仍负责创作页（有 DOM 替身测试，改它要跑 tests/workbench.test.cjs）。两脚本共享全局 `run/accept/current/requireConnection`。

## 4. 进度

见 `docs/development/Grovebot开发进度.md`（权威）。概要写在文末“检查点记录”。

## 5. 现状与下一步

【历史，2026-10-13 第三轮时的描述；当前状态见本文顶部入口】当时 82 项标为“程序完成”（未经人工验收）。并行分支 `feat/grovebot-maint`（PR #12）与 `feat/grovebot-assets`（PR #13）已用本地 `git merge` 合入本分支（a8eec65、a668600），当时两个 PR 保持打开未动；`进度-maint.md`、`进度-assets.md` 保留作历史，状态已并入主进度表。

下一步建议（按价值）：
1. 等 Codex 在 Windows 真机按 `待Codex验收.md` 验收，修复反馈。最可能出问题：Gemma 节点输入名推断（bindings.cjs）、原生视图快捷键与焦点、插件 pip 安装路径、恢复时文件被占用（Windows 下 ComfyUI 未完全退出时 rename 会 EBUSY/EPERM）。
2. 恢复引擎在 Windows 上对“正在被占用的目录”只会报错并保留 journal，可从资源页“继续恢复”。可以考虑加重试/等待进程退出。
3. R06 若用户希望走 ComfyUI-Manager：需先在真机确认 cm-cli 的确切命令与输出，再加到 `plugin-ops.cjs` 作为可选后端（仍需在事务内）。
4. 收藏板、查看器在大量图片时只做了分页（60/页）和逐个缩略图加载；如有性能问题可加虚拟滚动。
5. 仍不要合并 PR、不要再开 PR；草稿 PR #11 继续推送。

## 6d. 本轮新增（合并后接线、维护、批次 6）

- `desktop/services/maintenance-service.cjs`：组装 maintenance.*（manifest/backups/createBackup/verifyBackup/restoreBackup/pendingRestores/resumeRestore/transactions/pruneBackups/updateComfy/updatePlugin）与 resources.*（scan/detail/setNote/hash/references/impact/quickUse/plugins/enable/disable/install/removePlugin/modelRoots/moveModel），以及 `templates.installMissingPlugins`（O08）。`runTransaction(plan)` 用 maint 分支的 `MaintenanceTransaction`，锁是 api 共用的 `createLocks().environment`，队列钩子来自 taskService.hooks，每次写 `env_transactions`。main.cjs 在 createApi 之后 `Object.assign(api.methods, m.methods)`。
- `desktop/maintenance/plugin-ops.cjs`：installPlan/removePlan/updatePlan，都是 `{title, kind, roots, stage, apply, check, cleanup, result}`，必须交给 runTransaction。更新时本地 diff 存 `<数据>/patches/*.patch`，`checkout --force` 到目标后 `git apply --3way` 重放，冲突则 `result.pending`（不回滚更新本身，补丁保留）。没有用 stash（避免依赖 git 用户身份）。
- R03 引用来源：编辑器 `workspace.tabs`（草稿）、模板当前版本、最近 200 个任务快照的 apiPrompt。
- 队列 → 作品：`createTaskService({onTerminal})`，main 里传 `task => api.methods['assets.linkTask'](task.id)`，只在 succeeded 时调用，失败只记日志。
- A03：`tasks.run/runBatch` 按 `config.output.prefixMode`（或单次 `options.prefixMode`）调用 `applyOutputPrefix`，改动写进快照 `outputPrefix`。默认 none。
- UI：`desktop/ui/assets.js`（作品与收藏页，A04 查看器、A08 收藏板）、`desktop/ui/resources.js`（资源与维护页）；online.js 补齐依赖可填插件地址安装。
- E10：`editor-session.cjs` 的 `shortcutFor` + 原生视图 `before-input-event`：Ctrl+Enter 通过 `notify({shortcut:'run'})` 交给 tasks.js 的映作队列，Ctrl +/-/0 调 `setZoomFactor`。
- U05：`update-check.cjs` 的 `dueForCheck`、`startSchedule`（启动后及每小时判断一次；只查发行版与本地 git 状态，不 fetch），结果写 `update-check.json` 并发 `maintenance.updates` 事件。
- B02：`tools/check.cjs` 新增界面检查：`yz.<组>.<方法>(` 必须在 GROUPS 中、`q('#id')` 必须存在、禁止内联 `style="`（CSP `style-src 'self'` 会拦截，以前的几处已改成 class）、禁止 mock/fake/Math.random。
- B03：`package.json` main 改为 `desktop/entry.cjs`，带 `--yz-smoke=<file>` 时只跑 `desktop/smoke.cjs`（临时目录内验证 SQLite、sharp、模块加载）。Actions 构建后实际运行，并要求驱动为 better-sqlite3。run 38371603344 已通过。

## 6e. 坑

- `desktop-main.test` 用 vm 执行 main.cjs：main.cjs 顶层不能写 `return`，所以自检做成了独立入口 entry.cjs。
- CSP 不允许内联 style 属性，所以动态定位要用 `el.style.x = ...`（CSSOM）。
- `extraModelPaths` 参数是 yaml 路径而不是解析结果；用 `buildFolderMap({comfyRoot})` 即可（默认读取 `<root>/extra_model_paths.yaml`）。
- `ResourceNotes.set` 只接受白名单字段（没有 note，用 description）。
- `call(promise, okMessage)` 的第二个参数是成功提示，不是选项；需要静默时直接用 `yz.x.y().then(r => r.ok ? ... : ...)`。
- `workbench.js` 顶层 `let current` 是全局词法绑定，不在 `window.current` 上。
- 维护事务的备份不含应用自身的 SQLite（应用一直打开着，恢复它会出问题）；只覆盖 ComfyUI 与 Python 环境目录。

## 6f. 我的想法

- 最大的风险不在代码量，而在三个外部契约：ComfyUI 前端 `graphToPrompt/loadApiJson` 的行为、Gemma 节点的输入名、Windows 文件锁。三者都有替身测试，但替身只能证明“按我的理解是对的”。验收应先跑这三条主链（运行、仅润色、更新/恢复），再看边角功能。
- `api.methods` 后挂载的方式（Object.assign）比在 createApi 里继续加参数更不容易冲突，但这样一来 `tools/check.cjs` 只能按字符串搜方法名；如果以后重构，最好让每个服务导出方法清单，在一处汇总。
- 恢复/更新涉及删除和移动大目录。我刻意让所有“删除”都变成“移到回收区”，并且清理备份也只是移动；回收区目前没有自动清空入口，磁盘会慢慢涨，后面需要一个带确认的“清空回收区”。

## 6c. 批次 4/5（本分支部分）

- `desktop/services/online/`：`providers.cjs`（HF/Civitai，box 上实测过公共 API 搜索、详情与小文件下载）、`downloader.cjs`（.part + Range/If-Range 续传、sha256、原子改名、并发、取消、重启恢复；urlRef 不含令牌）、`online-service.cjs`（downloads.* 与 templates.importOnline）、`dependency-plan.cjs`（T08、O08 模型部分、R06 只读探测）。
- `desktop/services/update-check.cjs`：maintenance.checkUpdates/checkAppRelease/downloadAppRelease/openAppUpdateFolder（只读检测 + 显式下载校验）。
- UI：`desktop/ui/online.js`（在线资源页、下载列表、补齐依赖弹窗、从链接导入模板）、`desktop/ui/updates.js`（服务与日志页“版本与更新”）。
- 命名约定：为避免和 maint 分支冲突，本分支没有使用 `resources.*`，诊断与补齐放在 `templates.*`，更新检测方法名为 `maintenance.check*`。合并时注意 `desktop/main.cjs`、`desktop/preload.cjs`（GROUPS）和 `docs/development/tasks.json` 的冲突。
- `tools/check.cjs` 现在递归扫描 `desktop/services/` 子目录。

## 6. 任务链路速览（批次 2）

- `desktop/services/task-service.cjs`：组装 TaskRepository + QueueService + ComfyHttpClient + ComfySocket + ReferenceStore，提供 `tasks.*`（preview/run/previewBatch/runBatch/enhance/enhanceResult/list/get/cancel/retry/recheck/pause/resume/pickReference）与 S07 退出钩子。main.cjs 中数据库打不开时运行功能停用（日志有记录），其余功能照常。
- `shared/bindings.cjs`：按节点类型+连线推断参数（E07），Gemma 节点识别（类名匹配 lmstudio/prompt enhancer/gemma），仅润色子图（润色节点+上游+PreviewAny），采用文本后 `enable_llm=false`。
- `shared/prompt-check.cjs`：提交前本地检查（E09）。
- `editor-session.cjs` 新增 `compileTab`：后台标签先切过去编译再切回。
- UI：`desktop/ui/tasks.js`（运行栏、参考图、批量、仅润色弹窗、任务队列页）。`window.yzShell` 由 shell.js 暴露。
- 修复：better-sqlite3 是延迟加载原生模块，现在在 loadDriver 里用 `:memory:` 探测，Electron 下 ABI 不匹配时回退 node:sqlite（box 上用 Electron 启动验证过）。

## 6b. 模板与诊断（批次 3 中本分支负责的 T01–T07）

- `desktop/repositories/template-repo.cjs`：templates/template_versions 表（v1 迁移已有）+ `data/templates/{graphs,forms}/xx/<sha256>.json` 内容寻址；版本只追加。
- `shared/form-schema.cjs`：表单字段 = ParameterBinding；nodeId 用编译后 API 编号；映射校验/重新绑定只允许同类型同字段。
- `desktop/services/template-service.cjs`、`diagnostics-service.cjs`：接口都在 `templates.*` 分组（诊断也放这里，避免与 maint 分支的 `resources.*` 冲突）。
- `editor-session.cjs` 新增 `openGraph`、`tabGraph`、`replaceGraph`。
- UI：`desktop/ui/templates.js`（模板库页、存为模板、表单设置、诊断弹窗）。

## 7. 检查点记录

- 2026-10-13 本轮：合入 maint/assets；接线完成；R07、R08、U05、U06、U07、R06、O08、E10 与 B01–B06 全部程序完成。最后推送的提交见 `git log -1`；`npm run check`：214 项，213 通过，1 跳过，0 失败；Windows Actions run 38371603344 成功（含打包自检）。
- 批次 1：全部程序完成（F08：GitHub Actions Windows 构建在 cd4862b 首次全绿；之前 Windows 上的测试因 SQLite 文件句柄未关闭导致 EBUSY 失败，已修复）。
- 批次 2–5：见进度表。

## 主题 / 皮肤 / 无边框窗口（2026-10-13）
- `ui.theme`：`dark` | `light` | `system`（跟随系统用 matchMedia）。
- `ui.skin`：`default` | `nasa-punk`（叠在明暗之上；`data-skin`）。外观区两行：主题三卡 + 皮肤两卡（默认 / NASA朋克）。
- NASA 朋克：暗色科技底 + 橙/琥珀/青强调、细网格、等宽提示文字。
- 无边框：`BrowserWindow({frame:false})`；标题栏最小化 / 最大化·还原 / 关闭；`-webkit-app-region: drag`；preload `windowMinimize|Maximize|Close|IsMaximized` + `onWindowState`。
- NASA 朋克可读性：底板/面板抬亮；主题·皮肤选中卡改为描边+浅色叠色（禁止实心填充盖住预览与文字）。
- NASA 朋克按参考图重做：深海军星空底、粗橙+白、蓝橙黄任务章色条、干净飞行UI；选中卡仍为描边+浅叠色。
- 截图：`/workspace/yingzuo-ui-shots/nasa-01-home.png`、`nasa-09-settings.png`（含三颗窗口按钮与皮肤卡）。
- 测试：`npm run check` 339 / 338 通过 / 1 跳过。


## UI 视觉抛光（2026-10-13，无新功能）
- 提交：`ca2f8db`（`feat/grovebot-impl`）。仅 CSS / 少量空状态文案与 class，不改 IPC、API、业务逻辑。
- 方向：对齐根目录 A 测（`index.html` + `style.css`）——暗色、苔绿强调色 `--accent:#d1ed87`、圆角与间距、焦点环。
- 改动文件：
  - `desktop/workbench.css`：设计令牌、侧栏/标签/模式切换/表单卡片/作品网格/查看器/页脚
  - `desktop/ui/shell.css`：首页入口卡、导航 hover/active、列表行、空状态、对话框、队列任务卡、设置、起始页
  - `desktop/workbench.html`：资源页空状态、在线页说明改为 `.notice`
  - `desktop/ui/{assets,templates,tasks,online}.js`：空列表改为 `.empty-state` 结构（中文）
- CSP：未使用 HTML `style=` 属性；收藏板高度与查看器缩放仍走 CSSOM（`element.style`），符合约定。
- 未做：独立浅色主题（桌面端原本只有 dark / `color-scheme:dark`）；未改 A 测预览站本身。
- 截图（静态打开 `workbench.html`，无真实 IPC，故服务卡/列表多为空状态；分辨率 1440×960）：
  - `/workspace/yingzuo-ui-shots/01-home.png`
  - `/workspace/yingzuo-ui-shots/02-create.png`
  - `/workspace/yingzuo-ui-shots/02b-create-start.png`
  - `/workspace/yingzuo-ui-shots/03-templates.png`
  - `/workspace/yingzuo-ui-shots/04-online.png`
  - `/workspace/yingzuo-ui-shots/05-assets.png`
  - `/workspace/yingzuo-ui-shots/06-resources.png`
  - `/workspace/yingzuo-ui-shots/07-queue.png`
  - `/workspace/yingzuo-ui-shots/08-services.png`
  - `/workspace/yingzuo-ui-shots/09-settings.png`
- 测试：`npm run check` → 339 / 338 通过 / 1 跳过 / 0 失败（抛光前后一致）。
- PR #11 仍为草稿。

## 历史第七轮：PR11 代码与截图审阅 RV01–RV15 — 2026-10-13
- 审阅原文：docs/development/PR11代码与截图审阅-d5cca17.md（审阅 head d5cca17）。状态表：`node tools/pr11.cjs render`（Grovebot开发进度.md 的 RV 区块，“人工验收”列留空）。
- RV01 草稿哈希：`workspace-store.writeWorkspace` 对落盘（已脱敏）图算 graphHash；`readWorkspace(file, {resolveGraph})` 只在“解析占位符后哈希等于旧索引”时修复旧索引。
- RV02 密钥映射：forceInput/连线输入不占 widget 位；数量对不上时为“不确定”，导出不清空猜测位并在提示中列出；object_info 落盘缓存 `object-info-cache.json`，服务就绪时预热。
- RV03 任务快照：`desktop/services/snapshot-secrets.cjs`；TaskRepository.create 统一脱敏；旧快照由 secret-migration 迁移到新内容地址。
- RV04 服务三态：maintenance-service `probeState` → confirmed-stopped / running / unknown；unknown 阻止维护、移动与恢复。
- RV05 启动恢复：`desktop/startup-restore.cjs`；恢复前只用 `describeLayout`（不建目录）。
- RV06 停止/释放显存：api.cjs `guardedServiceOp`（环境锁→暂停租约→等 starting→锁内核实归属→后端 /queue 中其他来源任务）；外部实例释放显存需 `{confirmExternal:true}`；退出时有其他来源任务或无法确认则不停止。
- RV07/RV14：task-service `checkFinalPrompt` 对全部覆盖后的最终 prompt 校验；批量整组先校验，任一无效零入队；快照 form.values 为最终值。`queue.maxBatch` 是唯一上限来源（预览、planBatch、整组检查、批量弹窗）。
- RV08 快捷使用：不传 references（统一入口按标签关系解析并检查缺失）；确认返回 tabId/revision，运行带 expectedRevision。
- RV09 模板目录：固定为数据目录 templates，设置项只读显示；`paths.templates` 非空时给警告并忽略。
- RV10 Worker 临时文件：worker-pool `TEMP_PLAN` 由主进程分配临时名并写 `worker-temps.json`；worker 真实退出后清理；启动时 `configureShared` 只清理登记路径；关闭中/后 `sharedPool()` 返回已关闭的池（CLOSED），`reopenShared()` 才重建。
- RV11/RV12 配色：新增 `--nav-active-fg`、`--accent-fill`；NASA 组件统一使用 `--nasa-*` token，深/浅成对；NASA 浅色主按钮 #b84400。
- RV13 设置草稿：shell.js `settingsDraft` + `restoreDraft`；外观由 `saveAppearance` 只更新选中卡，失败恢复、按最新操作收敛；凭据区 `renderCredentials` 单独刷新。
- RV15 截图：`node tools/ui-shots.mjs`（需 `npm i --no-save puppeteer-core` 与 Chrome），固定数据 `tools/ui-shots/fixtures.json`，替身 `tools/ui-shots/stub.cjs`；输出 docs/development/ui-shots（40 张：default / light / nasa / nasa-light）与 manifest.json。
- 浏览器回归 `tests/review-rv13-ui.test.cjs` 需要 puppeteer-core 与 Chrome；Windows CI 未安装，自动跳过（静态对比度检查 review-rv11-12 照常运行）。
- 仍有限：截图是静态页 + 替身数据，不代表 Electron 真机；NASA 浅色、系统主题切换、Windows 下 worker 句柄释放与外部 ComfyUI 队列判断需真机验收（见 待Codex验收.md “PR11 代码与截图审阅（RV01–RV15）”）。

## 第六轮：PR11 第三轮审阅 C01–C09 — 2026-10-13
- 审阅原文：docs/development/PR11第三轮代码审阅与最终收尾计划.md（审阅 head f493fce）。状态表：`node tools/pr11.cjs render`（Grovebot开发进度.md 的 C01–C09 区块）。
- **范围冻结**：本轮之后不再加功能；剩下的只有 Codex 在 Windows 上的人工验收与验收中发现的问题修复。
- C01 图密钥：`shared/graph-storage-policy.cjs`（secureForStorage / stripForExport / resolveInMemory / scan）。草稿自动保存、关闭归档、模板版本、模板/诊断/工作流导出都经过该策略；启动迁移 `desktop/maintenance/secret-migration.cjs` 处理历史数据并写 `migrations/secret-scan.json`；应用备份前先迁移，仍有未处理项则阻止备份。
- C02/C03 维护事务：锁 → 锁内 gate → 暂停租约并等空闲 → services 检查 → 停本应用服务 → 备份 → staging → apply（先写 running）→ 检查。启动时按事务记录重建 hold；恢复失败保留 hold；被 hold 引用的备份不可清理。
- C04 应用恢复：`restore.cjs` 回滚可重入（冲突即停，不覆盖）；失败进入 `desktop/recovery.cjs` 恢复窗口；标记损坏时按 journal 重建。
- C05 模型移动：等空闲 + 服务检查；link 无覆盖提交；删源前重算哈希，变化则记录冲突、两份都留。
- C06 表单：版本固定（baseVersion）；`tasks.applyFormField` 带 expectedRevision；`checkFieldValue` 在运行/批量/增强前校验；复制标签保留 templateId/templateVersionId。
- C07 图包：导出/解析在 worker；子图槽位 `父:子`；导入可落为本地模板（source `package:<id>`），失败回滚关闭标签与关系。
- C08 worker：WorkerPool open/closing/closed，关闭后 run 报 CLOSED；任务输出关联 `AssetIndex.linkTaskOutputsAsync` 与收藏复制/校验走 worker。
- 原 3 个已知限制已解决：草稿自动保存明文密钥（C01）、任务输出关联与收藏复制同步执行（C08）、复制标签丢失模板/表单绑定（C06）。
- 仍为有限支持/残留：E07、S04 真实外部契约（交 Codex）；R06 受限 Git 后端；无 object_info 时密钥识别是启发式；离线导入图包时槽位输入只标“未验证”；图包导入若 setTemplateVersion 失败，本地模板条目可能残留；迁移会删除旧模板明文 blob（新 blob 先写入并更新行之后）。
- Artifact：Windows build 上传 `yingzuo-windows`。
- Codex 验收：待Codex验收.md “PR11 第三轮（C01–C09）”。

### 第六轮 CI 记录
- 代码 head 252d11a：Windows build https://github.com/TIPSONG/yingzuo/actions/runs/38392346922 成功，`npm run check` 339 项 / 338 通过 / 1 跳过 / 0 失败；Regression 38392347038、38392340988 成功；artifact `yingzuo-windows`。
- feab742、b78acd4 的 Windows build 失败（C01 迁移测试在 Windows 上先删目录后关数据库导致 EBUSY），252d11a 已修复。
- 本条记录所在的纯文档提交之后的 CI：提交时尚在运行（pending），结果以 PR #11 页面为准。

## 历史记录（以下为早期轮次，内容可能与当前实现不一致，仅供追溯）

### 第四轮（PR11 审阅修复）进度 — 2026-10-13（R22 复核后）
- 审阅原文：docs/development/PR11代码审阅与下一轮程序计划.md；逐项状态：`node tools/pr11.cjs render`（数据 pr11-status.json）；82 项：`node tools/progress.cjs render`（新增“有限支持”状态）。
- 已合并 origin/feat/grovebot-review2（head bbbcba7 之前的全部提交），并接入 R14/R17(部分)/R18/R19/R20。
- 程序完成：D01–D03、D05–D15；PR11-R01–R09、R12–R16、R18–R21。
- 当时实现中（现已由 S07／S08／S09 与后续 C08／RV10 完成）：D04/PR11-R10（左侧参数面板、润色流程未走自定义表单）、PR11-R11（导出/恢复带素材 manifest、关闭标签归档时关系）、PR11-R17（缩略图/图片元数据仍在主进程）。
- 82 项复核：E07/T01/O07/S04/R06 改为“有限支持”，T03 改为“实现中”，其余维持程序完成（均仍需 Windows 人工验收）。
- 下一步建议：D04 左侧参数面板（workbench.js renderFields 改为优先用 tasks.form，注意子图节点 ID “父:子” 与画布 widget 的映射）；R11 导出 manifest；R17 assets 缩略图改走 WorkerPool。
- 关键新模块：desktop/services/quit-flow.cjs、desktop/maintenance/app-backup.cjs、entry.cjs（单实例锁 + 应用数据恢复）、queue-service 暂停租约/followers/enqueueGroup。

### 第五轮（PR11 第二轮审阅 S01–S10）进度 — 2026-10-13（已被第六轮取代）
- 审阅原文：docs/development/PR11第二轮代码审阅与收尾计划.md（审阅 head 68f7598）；状态表：`node tools/pr11.cjs render`（Grovebot开发进度.md 中 N01–N06、S01–S10 区块）。
- 82 项：79 程序完成、3 有限支持（E07、S04 真实外部契约交 Codex；R06 受限 Git 后端为原方案允许的范围）。T01（模板缩略图）、T03（表单）、O07（在线模板库浏览）本轮完成。
- S01 提交屏障：`queue-service.cjs` 的 `starting` 计数 + `blocked()` 在 ready / 后端 queue / GPU 锁三个等待点后重检，取得 GPU 锁后同步进入 preparing。
- S02 持久阻断：`maintenance-holds.json`；启动重建租约；`releaseHoldsFor(backupDir)` 只解除对应备份；无备份阻断需 `maintenance.clearHold(id,{confirm:true})`；`services()` 核对 owned 后端里的外部任务；main 包装 `services.startComfy` 受 gate 约束。
- S03：旧后端运行中取消默认 UNSUPPORTED；全局中断需 `tasks.cancel(id,{globalInterrupt:true})`（界面确认框）。
- S04：`recoverModelMoves` 删源前重算源 hash，冲突两份保留；只有完整 tmp 时补完；路径须在已登记模型根内；取环境锁与租约，有任务则推迟。
- S05：`taskService.submissions`（enqueueCompiled/enqueue/enqueueGroup）唯一提交入口；快捷使用已改走；`secrets.redactGraph` 用于存为模板；模板导出清空占位；测试静态扫描禁止其他文件调用 queue.enqueue。限制：工作区草稿自动保存仍按 ComfyUI 原样保存图。
- S06：`createBackup({databasesFirst, postCheck, excludePaths, protectedPaths, copyImpl})`；应用备份先 VACUUM INTO 再复制只增目录、包内核对引用闭包；`applyPendingAppRestore` 失败进入恢复模式（pending.action=null），用户选择 resume（同一 journal）或 rollback（`RestoreEngine.rollback`）后重启。
- S07：左侧正式参数面板（workbench.js `loadFormPanel/renderFormPanel`）+ `shared/form-targets.cjs` 映射到 UI 根图；标签 `templateVersionId`；`formProvider(templateId, versionId)`；运行按钮=Ctrl+Enter。
- S08：`desktop/services/graph-package.cjs`（.yingzuo.json 图包）；`tasks.exportPackage/importPackage/closedList/reopenClosed`；关闭归档写 `<id>.meta.json`。
- S09：`sharedPool()`；worker 任务 imageMeta / thumbnail（sharp）/ copyFile；AssetIndex 异步扫描与缩略图去重；打包自检 `worker` 步骤。
- S10：在线模板库（`templates.browseOnline` 等，官方 Comfy-Org/workflow_templates 索引，样本夹具 tests/fixtures/comfy-workflow-templates-index.sample.json）；模板缩略图（`templates.thumbnail/setThumbnail`，任务成功自动生成）。
- 需要 Codex 在 Windows 上人工验收：见 待Codex验收.md “PR11 第二轮（S01–S10）”。

##### 第五轮 CI 记录
- 8654359（及 a11de2c、e6d2d80、ce73b3d、7d6f45e、14ef487、ff3604e）：Windows build 与 Regression 全部成功；打包自检的 worker 步骤（asar 内加载 worker、sharp 缩略图/元数据/复制）已通过。
- PR #11 描述已更新，仍为草稿。

## 创作页工具条（2026-10-13）
固定高度工具条导致运行按钮叠 `#status`。已改为自适应网格；见 commit「创作页工具条改为自适应网格」。
