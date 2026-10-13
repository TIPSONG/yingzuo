# 交接：给下一个 agent（Grovebot 实现进度）

更新时间：见文末。本文件随每次检查点更新，副本在 `/workspace/yingzuo-handoff.md`（box 上）。

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

## 5. 下一步（按顺序）

并行分工：`feat/grovebot-assets`（A01–A08）与 `feat/grovebot-maint`（U01–U04、R01–R05）由其他 worker 负责，本分支**不实现、不改它们在进度表中的行**（它们用 `docs/development/进度-assets.md` / `进度-maint.md`）。

1. E10 剩余（图片选择/下载、缩放快捷键）。
2. 批次 4：O01–O08、R06–R08、T08；批次 5：U05–U08。
3. 草稿 PR #11 已开，继续推送到同一分支；不要再开 PR、不要合并。

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

- 批次 1：除 F08（等 Windows 构建）外程序完成；S07 已在批次 2 完成。
- 批次 2：Q01–Q10、E07–E09 程序完成（ComfyUI 为替身，Gemma 节点输入名为推断，需 Codex 用真实工作流验收）；E10 实现中。
- 批次 3（本分支部分）：T01–T07 程序完成。
- 最近提交见 `git log`；`npm run check`：160 项，159 通过，1 跳过。
