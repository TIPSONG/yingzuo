# 进度：作品与导出（A01–A08）

分支 `feat/grovebot-assets`（基于 `feat/grovebot-impl`）。本文件只记录 A 组，不改主进度表 `Grovebot开发进度.md`；合并时由主线把状态同步到 `tasks.json`。

开发环境：Linux 容器，无 Windows / ComfyUI / GPU。所有测试使用真实临时目录、真实 SQLite（better-sqlite3）与 sharp 生成的真实图片；ComfyUI 输出仅以 history 结构（filename/subfolder/type）替身表示。状态最多到“程序完成”。

## 新增文件（全部为新文件，共享文件只做追加）

| 文件 | 内容 |
|---|---|
| `desktop/core/image-meta.cjs` | 格式识别；PNG chunk / JPEG 段 / WebP RIFF chunk 解析与过滤；ComfyUI/A1111 生成信息读取 |
| `desktop/services/asset-index.cjs` | A01 扫描/监视/分页/缺失标记；A02 history 输出解析与关联；A04 查看器详情与缩略图缓存 |
| `desktop/services/output-prefix.cjs` | A03 日期/工作流输出前缀（仅登记保存节点，作用于快照副本） |
| `desktop/services/asset-files.cjs` | A05 打开文件/所在目录/位置；A06 原图导出；A07 分享副本导出 |
| `desktop/services/favorites.cjs` | A08 收藏板与相册自动排列 |
| `desktop/services/assets-api.cjs` | `assets.*` 方法表 |
| `tests/assets.test.cjs` | 12 项 node:test |

共享文件改动：`desktop/services/api.cjs` +3 行（require 与展开 `createAssetsMethods`），`desktop/preload.cjs` +1 行（`assets` 分组）。未新增数据库迁移，复用 v1 的 `assets` / `favorites` 表。

## 任务状态

| 编号 | 状态 | 说明 | 待 Codex 验证 |
|---|---|---|---|
| A01 输出索引 | 程序完成 | 递归扫描已配置 output/input 目录，不移动原图；大小+mtime 未变跳过；按批 `setImmediate` 让出事件循环；未见文件标 `missing`（恢复后自动取消）；分页、关键词（路径+提示词，LIKE 转义）、格式/根/任务筛选；`fs.watch` 递归监视 + 去抖增量更新 | Windows 上 `fs.watch` 递归监视、中文/长路径、大目录（万级）扫描耗时与 UI 不卡顿 |
| A02 任务输出关联 | 程序完成 | 按 history `filename/subfolder/type` 解析到对应根目录；文件名/子目录按 Windows 规则校验，拒绝穿越；未配置目录（外部 ComfyUI、temp）返回 `unresolved` 和原因，不猜路径；文件不在则 `missing`；关联写入 `assets.task_id` 与输出节点信息 | 真实 ComfyUI history 输出与本机 output 目录对应；QueueService 完成任务后自动调用 `assets.linkTask`（队列接入由其他 worker 负责，此处只提供接口） |
| A03 日期／工作流输出 | 程序完成 | `applyOutputPrefix` 只改 `SaveImage/SaveAnimatedWEBP/SaveAnimatedPNG/SaveVideo/SaveWEBM` 的字符串 `filename_prefix`；目录 `映作/日期/显示名_稳定ID前8位/原前缀`；幂等；连线前缀和未登记保存节点原样保留并列入 `untouched`；返回副本，不改原 prompt | 在 Q06 提交路径中接入（需配置项决定模式）；真实 ComfyUI 生成后目录结构 |
| A04 缩略图与查看器 | 程序完成（后端） | sharp 生成 webp 缩略图，键含路径+mtime+大小+尺寸，自动失效；详情含任务记录、输出节点、提示词、seed、采样参数、模型、是否含工作流；缺失项列在 `missingFields`；最近作品 | 作品页 UI（网格、大图查看器、筛选）尚未做，避免与 `shell.js` 并行改动冲突；Electron 打包后 sharp 原生模块加载 |
| A05 文件入口 | 程序完成 | 仅 `shell.openPath` / `showItemInFolder`，不拼命令；路径必须在登记目录内；拒绝打开可执行类型；失败返回路径与原因；`assets.openLocation` 支持 output/input/favorites/downloads/backups/logs | Windows 资源管理器实际打开/定位 |
| A06 原图导出 | 程序完成 | `COPYFILE_EXCL` 字节复制，重名生成 `name (2).ext`，EEXIST 竞争重试，校验大小；目录经系统对话框选择 | Windows 对话框与网络盘/中文目录 |
| A07 分享副本导出 | 程序完成 | PNG：保留关键块及 tRNS/gAMA/cHRM/sRGB/iCCP/sBIT/pHYs/bKGD/cICP/APNG 块，移除 tEXt/zTXt/iTXt/eXIf/tIME/私有块，IDAT 原样；JPEG：移除 EXIF/XMP/IPTC/COM/其他 APPn，保留 JFIF、ICC_PROFILE、Adobe 段与扫描数据；WebP：移除 EXIF/XMP/未知 chunk，清 VP8X 标志并修正 RIFF 长度。测试验证解码像素逐字节一致、透明度与 ICC 保留。GIF 等其他格式/结构异常：`UNSUPPORTED`，不生成文件 | 用 ComfyUI 实际输出（含 workflow）与第三方 JPEG（多 ICC 段、MPF）再抽查 |
| A08 收藏板 | 程序完成（后端） | 复制到 `收藏目录/YYYY-MM/哈希.ext`，sha256 去重并校验副本；保留来源路径；取消收藏只把收藏副本移到 `trash/favorites`，原始文件不动；列表识别 `sourceMissing` / `broken`；等高行相册自动排列 | 收藏板 UI；参考图入口（从参考图区收藏）待 R 组接口 |

## 测试

`npm run check`：156 项，155 通过，1 跳过（原有），0 失败；其中 `tests/assets.test.cjs` 12 项全部通过。

## 检查点

- 2026-10-13：A01–A08 后端程序完成，`assets.*` 接口接入 API 与 preload。
