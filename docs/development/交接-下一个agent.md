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

1. 批次 2：Q01 任务仓库（SQLite tasks/task_events + task-snapshots/ 内容寻址快照）→ Q02 Comfy HTTP/WS 客户端（`desktop/adapters/comfy-http.cjs`）→ Q03 调度器（GPU 锁、外部任务等待）→ Q04 提交与断连核对 → Q05 → Q06 运行按钮 → Q07 取消/重试 → Q08/Q09 Gemma → E07 五图表单 binding → E08 参考图 → E09 编译 → E10。完成 Q03 后把 `api.hooks.activeTasks/waitForIdle/cancelActive` 接上，S07 改为程序完成。
2. 批次 3：A 模块（作品索引、sharp 缩略图、导出、收藏）、T01–T07、R01–R05、U01–U04（备份事务必须先于插件安装）。
3. 后续批次见计划书第 7 节。

## 6. 坑与注意

- `tests/desktop-main.test.cjs` 用 vm 运行 main.cjs，require 被替换：`./xxx` 会解析到真实 desktop 目录；main 里不要直接用 `process`（vm 上下文没有），新模块里可以。mock 的 `webContents.send` 把 `yingzuo:event` 和状态分开收集。
- 新加的 preload 方法必须在 api.cjs 里有 `'group.name'` 实现，否则 `npm run check` 失败。
- better-sqlite3 在 Electron 下需要 ABI 重建；开发版未重建时回退 node:sqlite（Electron 44 内置）。打包由 electron-builder `npmRebuild` 处理，Windows 构建走 `.github/workflows/windows-build.yml`。
- 不要凭旧 PID 结束进程；停止服务只走 `ComfyProcessManager.stop()`（重新核对启动时间和可执行路径）。
- 不要在 UI 放占位按钮：功能没实现就不放入口。

## 7. 个人笔记 / 想法

- 计划非常大（82 项）。我优先把“地基 + 真正能被调用的服务层 + 单元测试”做扎实，UI 只接真实接口；宁可状态标“实现中/阻塞”，也不标假完成。
- 编辑器会话没有进一步细拆成多个模块，因为现有 22 个 vm 测试覆盖了它的串写保护行为，大拆风险高；后续若要拆，先补测试。
- API 格式导入依赖 `app.loadApiJson` 在“已绑定文档”内执行后能重新绑定——这是根据前端源码推断的行为，Codex 实机验证最重要。

## 检查点记录

- 2026-10-13 16:14 (UTC+8)：批次 1 代码完成（S07 待队列接入、F08 待 Windows 构建结果），npm run check 通过。
