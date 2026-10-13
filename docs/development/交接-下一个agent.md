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

1. 批次 2 剩余：把 `QueueService`（`desktop/services/queue-service.cjs`）接入 main/api：`Database.open(layout.database)`、`new TaskRepository(db, new SnapshotStore(layout.taskSnapshots))`、启动时 `recoverOnStartup()`、`tasks.*` 方法（enqueue/list/get/cancel/retry/recheck/pause/resume）加到 api.cjs 与 preload `GROUPS`；把 `activeTasks/waitForIdle/cancelActive/pauseSubmissions/resumeSubmissions` 接到 api.hooks，S07 即可标程序完成。ComfySocket 事件转给 `queue.handleSocketEvent`。
2. Q06 统一运行入口（创作页“运行”按钮 → compile → enqueue）、Q08/Q09 Gemma、E07–E10、Q10 批量 UI。
3. 批次 3–6（A/T/R/U → O/R06-08/T08 → Q10/U05-08 → B01-B06）。
4. 草稿 PR 已开：https://github.com/TIPSONG/yingzuo/pull/11，继续推送到同一分支即可，不要再开 PR、不要合并。

## 6. 检查点记录

- 批次 1：除 F08（等 Windows 构建）、S07（等队列钩子）外程序完成，提交 b84553c。
- 批次 2 部分：Q01–Q05、Q07 程序完成（tests/queue.test.cjs 13 项，ComfyUI 为内存替身）；Q10 恢复/FIFO 已实现；提交 5bbd62c。`npm run check`：144 项，143 通过，1 跳过，0 失败。
- 未做：Q06、Q08、Q09、E07–E10 以及批次 3–6 全部。
