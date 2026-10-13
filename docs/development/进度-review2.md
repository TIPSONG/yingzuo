# 进度 · review2（分支 feat/grovebot-review2）

依据《PR11代码审阅与下一轮程序计划.md》。本分支只做与队列／标签工作区／服务进程／main.cjs 退出流程无关的独立项，避免与 feat/grovebot-impl 上的优先项冲突。

不碰：D01/D02/R07/R08（Qwen/Gemma 适配）、D03/R09（异步标签）、D04/R10（表单接入）、D05/D06/R01/R02（维护/恢复）、D09/D11/R04/R05（服务归属、取消退出）、R03/R06/R11/R12/R13、queue/tabs/workspace/service/main.cjs。

| 项 | 内容 | 范围（文件） | 状态 |
| --- | --- | --- | --- |
| R15 / D14 | 206 续传核对来源身份（ETag/Last-Modified、Content-Range 完整校验），无可靠身份时从零重下 | desktop/online/downloader*.cjs、tests/downloader-resume.test.cjs | 进行中 |
| R16 / D13 | 分享 JPEG 完整遍历标记（多 SOS、扫描间 APP/COM），Exif 方向非 1 时拒绝无损剥离 | desktop/core/image-meta.cjs、tests/image-meta-jpeg.test.cjs | 待做 |
| R18（部分）/ D15 | 新增独立脱敏工具 shared/secret-fields.cjs（识别 password/已知 secret 字段，替换为 credentialRef 占位）+ 测试；接入快照存储留给主线 worker 决定 | shared/secret-fields.cjs、tests/secret-fields.test.cjs | 待做 |
