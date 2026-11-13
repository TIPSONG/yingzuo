# 维护与资源模块进度（U01–U04、R01–R05）

分支 `feat/grovebot-maint`（基于 `feat/grovebot-impl`）。开发环境为 Linux，无 ComfyUI／Windows；状态最多到“程序完成”，标注需 Codex 在 Windows 真实环境验收的内容。

| 任务 | 状态 | 文件 | 测试 | 待 Codex 验收 |
|---|---|---|---|---|
| U01 环境清单 | 程序完成 | desktop/maintenance/env-manifest.cjs | tests/maint.test.cjs | 真实 ComfyUI 便携版：python_embeded／venv 判定、pip freeze、前端版本读取 |
| U02 可恢复备份 | 程序完成 | desktop/maintenance/backup.cjs | tests/maint.test.cjs | Windows 长路径、只读文件、杀毒占用；大插件目录耗时 |
| U03 恢复引擎 | 程序完成 | desktop/maintenance/restore.cjs | tests/maint.test.cjs | Windows 下目录被占用时 rename 失败的提示与 resume |
| U04 维护事务与锁 | 程序完成（未接入 api） | desktop/maintenance/transaction.cjs | tests/maint.test.cjs | 与真实 comfy-process 停止／启动、队列 waitForIdle 联调 |
| R01 目录扫描 | 程序完成 | desktop/resources/model-scan.cjs | tests/resources.test.cjs | 真实 /api/models 与 Windows 符号链接／目录联接（junction）去重；大目录 hash 耗时 |
| R02 资源详情 | 程序完成 | desktop/resources/resource-details.cjs | tests/resources.test.cjs | 用真实 Qwen／Gemma GGUF、LoRA safetensors 核对元数据字段 |
| R03 引用索引 | 程序完成（未接入草稿/任务仓库） | desktop/resources/reference-index.cjs | tests/resources.test.cjs | 五个真实模板的引用抽取结果 |
| R04 快捷使用 | 程序完成（注册表可扩展） | desktop/resources/quick-use.cjs | tests/resources.test.cjs | 在真实 Comfy 中运行插入 LoRA 后的 prompt；与节点适配注册表（其他分支）对接 |
| R05 插件清单 | 程序完成 | desktop/resources/plugin-inventory.cjs | tests/resources.test.cjs | 真实 /object_info 的 python_module 格式；与 ComfyUI-Manager 禁用约定共存 |

## 说明

- 全部模块均为新增文件，没有修改共享文件；尚未接入 `api.cjs`／preload／UI（避免与并行分支冲突），接入时：`maintenance.*` 方法应通过 `MaintenanceTransaction` 并使用 `createLocks().environment`；插件禁用／启用必须在维护事务内执行。
- SQLite 备份使用 `VACUUM INTO`（包含 WAL 中已提交数据），备份后 `integrity_check`。
- 恢复：当前目录改名为 `<原路径>.yz-scene-<恢复id>` 保留现场；备份时被排除的 models/output 等从现场搬回；journal 位于调用方指定目录，`pending()` 可在启动时列出未完成恢复，`resume(id)` 继续。
- 测试：`npm run check` 160 项，159 通过，1 跳过（原有），0 失败；新增 tests/maint.test.cjs 10 项、tests/resources.test.cjs 6 项，均只在系统临时目录操作。
