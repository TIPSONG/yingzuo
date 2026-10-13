# 进度 · review2（分支 feat/grovebot-review2）

依据《PR11代码审阅与下一轮程序计划.md》。本分支只做与队列／标签工作区／服务进程／main.cjs 退出流程无关的独立项，避免与 feat/grovebot-impl 上的优先项冲突。

不碰：D01/D02/R07/R08（Qwen/Gemma 适配）、D03/R09（异步标签）、D04/R10（表单接入）、D05/D06/R01/R02（维护/恢复）、D09/D11/R04/R05（服务归属、取消退出）、R03/R06/R11/R12/R13、queue/tabs/workspace/service/main.cjs。

| 项 | 内容 | 范围（文件） | 状态 |
| --- | --- | --- | --- |
| R15 / D14 | 206 续传核对来源身份（ETag/Last-Modified、Content-Range 完整校验），无可靠身份时从零重下 | desktop/services/online/downloader.cjs、tests/downloader-resume.test.cjs | 完成（7 项回归）|
| R16 / D13 | 分享 JPEG 完整遍历标记（多 SOS、扫描间 APP/COM），Exif 方向非 1 时拒绝无损剥离 | desktop/core/image-meta.cjs、tests/image-meta-jpeg.test.cjs | 完成（6 项回归，sharp 真实夹具；方向策略=拒绝分享副本，不做像素旋转）|
| R18（部分）/ D15 | 新增独立脱敏工具 shared/secret-fields.cjs（识别 password/已知 secret 字段，替换为 credentialRef 占位）+ 测试；接入快照存储留给主线 worker 决定 | shared/secret-fields.cjs、tests/secret-fields.test.cjs | 工具完成（3 项回归）；**未接入**快照存储/导出，需主线在 task-repo/提交路径调用 redactForStorage/resolveSecrets |

全量：`npm test` 248 项，247 通过、1 跳过；`node tools/check.cjs` 通过。

## 第二轮（R14/R17/R19/R20）

| 项 | 内容 | 范围 | 状态 |
| --- | --- | --- | --- |
| R14 | 回收区登记/列表/恢复/清理计划（只限本应用登记条目，保护在用备份/引用） | desktop/maintenance/trash-store.cjs（新增）| 进行中 |
| R17 | worker 执行层（sha256/大图读取上限，可取消） | desktop/core/worker-pool.cjs、desktop/core/workers/*（新增）| 待做 |
| R19 | 批量纯规划校验（全量校验后才返回计划，第 N 项无效不提交任何项） | shared/batch-plan.cjs（新增）| 待做 |
| R20 | 稳定 workflowId + SaveImageAdvanced 适配纯函数 | shared/output-plan.cjs（新增）| 待做 |
