# 维护与资源模块进度（U01–U04、R01–R05）

分支 `feat/grovebot-maint`（基于 `feat/grovebot-impl`）。开发环境为 Linux，无 ComfyUI／Windows；状态最多到“程序完成”，标注需 Codex 在 Windows 真实环境验收的内容。

| 任务 | 状态 | 文件 | 测试 | 待 Codex 验收 |
|---|---|---|---|---|
| U01 环境清单 | 程序完成 | desktop/maintenance/env-manifest.cjs | tests/maint.test.cjs | 真实 ComfyUI 便携版：python_embeded／venv 判定、pip freeze、前端版本读取 |
| U02 可恢复备份 | 程序完成 | desktop/maintenance/backup.cjs | tests/maint.test.cjs | Windows 长路径、只读文件、杀毒占用；大插件目录耗时 |
| U03 恢复引擎 | 程序完成 | desktop/maintenance/restore.cjs | tests/maint.test.cjs | Windows 下目录被占用时 rename 失败的提示与 resume |
| U04 维护事务与锁 | 程序完成（未接入 api） | desktop/maintenance/transaction.cjs | tests/maint.test.cjs | 与真实 comfy-process 停止／启动、队列 waitForIdle 联调 |
