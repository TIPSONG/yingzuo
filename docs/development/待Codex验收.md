# 待 Codex 验收清单

本清单只列 Grovebot 已写完程序、但必须在真实 Windows + ComfyUI + LM Studio 环境验证的功能。Grovebot 没有执行任何人工验收；“验收结果”一栏留空。

## 通用准备

- 分支：`feat/grovebot-impl`。`npm ci` 后 `npm run desktop` 启动开发版（better-sqlite3 若未按 Electron ABI 重建，会自动回退到 Electron 内置 `node:sqlite`，日志中可见驱动名）。如需原生驱动：`npm run rebuild:electron`。
- 开发版数据目录：`<仓库>\.local\data\`（首次启动会把旧 `.local\desktop-workspace.json` 和 `closed-workflows\` 复制导入，源文件保留，标记在 `.local\data\migrations\legacy-local-import.json`）。
- 安装版数据：`%APPDATA%\映作\data\`；便携版：exe 同目录放 `portable.flag` 后使用 `data\`。
- 日志：数据目录 `logs\yingzuo.log`（JSON 行，已脱敏）；本应用启动的 ComfyUI 输出在 `logs\comfyui.stdout.log / comfyui.stderr.log`。

## 批次 1

| 功能 | 入口 | 怎么验 | 已知限制 | 验收结果 |
| --- | --- | --- | --- | --- |
| 旧数据一次性导入 | 首次启动 | 已有 P0 `.local` 草稿的机器启动后，首页“数据”显示“已从旧 .local 导入”；原文件仍在；再启动不重复导入 | 只导入工作区与关闭副本，不搬 exports |  |
| 首页与导航 | 启动后默认页 | 首页先出现；节点/表单/新建三个入口并列；A 测只在侧栏“A 测界面预览” |  |  |
| 服务探测 | 首页“本机服务” | 分别显示端口、身份、WebSocket、编辑器；LM Studio 分别显示 CLI、API、模型、Gemma、已加载实例；把 8188 换成其他程序时显示“端口被占用” | `lms ps --json` 输出格式未实机核对 |  |
| 按需启动 ComfyUI | 首页卡片“启动 ComfyUI” | 无服务时从配置的 Python 启动并等待真实就绪；已有服务时显示“外部服务”不重复启动；超时提示日志路径 | 启动参数中 `--listen/--port` 由地址决定 |  |
| 停止与显存 | 卡片“停止 / 释放显存” | 只对本应用启动的实例显示停止；外部服务保持；/free 不存在时提示不支持 | 停止使用 taskkill /T，未实机 |  |
| LM Studio API | 卡片“启动 API 服务” | `lms server start`；原本已运行则标记外部；不卸载任何模型 |  |  |
| 托盘与单实例 | 关闭窗口 / 再次启动 | 关闭先保存再缩托盘；托盘菜单显示状态、打开输出目录、退出；重复启动聚焦已有窗口 | 设置中可关闭“缩到托盘” |  |
| 退出 | 托盘“退出映作” | 先保存草稿，再停止本应用启动的服务，然后退出；保存失败保留窗口 | 运行任务的等待/取消对话框在批次 2 接队列后生效 |  |
| 设置 | 设置页 | 修改路径、选择目录、错误地址给出字段级错误；配置损坏时用默认值启动并提示原文件已另存 |  |  |
| 凭据 | 设置页“在线来源凭据” | DPAPI 可用时加密保存；不可用时拒绝保存 |  |  |
| 多标签 | 创作页 | 重命名、关闭恢复、模式与视口（缩放/平移）重启后保持；同一模板重复打开复用标签 |  |  |
| 起始页 | 创作页 ＋ | 拖入/选文件/粘贴 JSON/模板/空白；取消不改变当前图；起始页打开时原生画布被隐藏 |  |  |
| API 格式导入 | 起始页粘贴 API JSON | 用前端 loadApiJson 重建；缺失节点类型被列出；原文件在 `data\imports\` | 依赖前端 1.53.x 的 loadApiJson 行为 |  |
| 诊断导出 | 服务与日志页 | 导出 JSON 不含令牌、密文、用户名路径 |  |  |
| A 测草稿迁移 | A 测设置“导出草稿”→ 桌面设置“导入 A 测草稿” | 导入后提示需重选参考图数量 | 只保存，不自动转成工作副本 |  |

## 批次 2（部分）

| 任务 | 需要的真实环境 | 验收步骤 | 验收结果 |
|---|---|---|---|
| Q02/Q04 | 真实 ComfyUI | 提交时断网/杀进程，确认任务进入“核对中”后按 history 判为成功或“状态未知”，且不重复提交 |  |
| Q05 | 真实 ComfyUI | 故意设置非法参数，确认节点级错误清单；显存不足时记录出错节点 |  |
| Q07 | 真实 ComfyUI（新旧两版） | 运行中取消只中断目标；老版本服务需确认中断前已核对正在运行的就是目标 |  |
| Q10 | 真实 ComfyUI | 有排队任务时退出再启动：未提交任务为“已暂停”，已提交任务按 history 核对 |  |

## 批次 2（续）

| 任务 | 需要的真实环境 | 验收步骤 | 验收结果 |
|---|---|---|---|
| Q06 | Windows + ComfyUI | 打开文生图模板 → 运行栏“运行”/Ctrl+Enter → 任务队列页出现任务并完成；空图点击运行应提示“空图” |  |
| Q08 | ComfyUI + LM Studio + Gemma 工作流 | “仅润色”只出现文本，不出图（检查 output 目录无新图）；“采用并生成”后 LM Studio 日志不应再收到请求。**核对润色节点的真实类名与输入名（当前按 prompt/text + enable_llm 推断）**；ComfyUI 需有 PreviewAny 节点 |  |
| Q09 | 同上 | 自动润色生成：Gemma 上下文 8192；接 3 张参考图时应被拒绝；显存在润色后释放 |  |
| Q10 | ComfyUI | 批量 2 提示词 × 2 次 → 4 个任务按顺序执行；重启后未提交任务为“已暂停” |  |
| E07 | 五个真实模板 | 在每个模板上调用“批量…”弹窗，确认识别出的提示词/seed 节点正确 |  |
| E08 | ComfyUI | 多图编辑模板“参考图…”选择两张图 → 运行 → ComfyUI input/yingzuo/ 下出现上传文件，结果使用了参考图；重启后再运行能补传 |  |
| E09 | ComfyUI | 在后台标签触发编译（批量弹窗会编译当前标签）；切回原标签无变化 |  |
| S07 | Windows | 任务运行中点托盘“退出映作”：三个选项分别正确 |  |

## 批次 3（T01–T07）

| 任务 | 需要的真实环境 | 验收步骤 | 验收结果 |
|---|---|---|---|
| T01/T02 | Windows | 模板库“导入内置五个模板”（工作流目录已配置）；打开 → 修改 → 存为模板新版本 → 版本列表恢复旧版；确认 ComfyUI workflows 目录原文件未改动 |  |
| T03/T04 | ComfyUI | 表单设置：改名/分组/范围后保存；在画布删除 KSampler 或把 steps 改为连线，再打开表单设置应显示失效与候选 |  |
| T05 | ComfyUI + LM Studio | 诊断显示三个来源的实时时间；关闭 ComfyUI 后再次诊断显示“离线，使用缓存” |  |
| T06/T07 | ComfyUI | 把模型名改成不存在的同架构文件 → 诊断给出候选 → 应用 → 自动复查通过 → 撤销恢复 |  |

## 批次 4/5（本分支部分）

| 任务 | 需要的真实环境 | 验收步骤 | 验收结果 |
|---|---|---|---|
| O02/O03 | Windows + 网络 + 凭据 | 设置中保存 HF/Civitai 凭据；搜索并下载一个 gated HF 文件与一个 Civitai LoRA 到 models/loras |  |
| O05/O06 | Windows | 下载大文件中途暂停/退出应用 → 重启后“已暂停”，继续后从断点续传，完成后 sha256 核对通过；跨盘目标目录 |  |
| O07 | 网络 | 从 GitHub/HF 的工作流 JSON 链接导入，模板库显示作者/许可 |  |
| T08/O08 | ComfyUI | 打开缺模型的工作流 → 补齐依赖 → 查找来源 → 下载 → 重新诊断通过 |  |
| R06 | ComfyUI + Manager | 补齐依赖弹窗/资源页插件区显示 Manager 版本；插件操作走映作 Git 事务（不调用 cm-cli） |  |
| U05 | ComfyUI git 安装 | “检查 ComfyUI 与插件”显示版本/本地改动；“联网获取远端版本”显示落后提交 |  |
| U08 | 发布了 Release 的仓库 | 检查映作新版本；有 SHA256SUMS.txt 时下载并校验；仓库私有时提示手动流程 |  |

## 本轮（合并 maint/assets 后的接线、R07/R08/U05–U07/O08/E10、批次 6）

| 任务 | 需要的真实环境 | 验收步骤 | 验收结果 |
|---|---|---|---|
| U01–U04 | Windows + ComfyUI（git 安装） | 资源与维护 →“立即备份 ComfyUI”：本应用启动的 ComfyUI 被停止后恢复启动；外部启动的 ComfyUI 运行时应被拒绝；备份不含模型权重；“维护记录”出现一条完成记录 |  |
| U06 | 同上，含 Gemma 本地补丁 | “更新 ComfyUI 到指定版本…”填一个较新标签：完成后 `git diff` 仍含 Gemma 补丁；构造冲突时提示“列入待处理”，`<数据目录>\patches\` 有补丁文件；更新失败时自动恢复到更新前 |  |
| U07 | 同上 | 查看备份/校验/恢复到某备份（会停服务、暂停队列）；恢复中途杀进程 → 重启后资源页出现“未完成的恢复”可继续；“按保留策略清理”只移到回收区 |  |
| R01/R02/R05 | ComfyUI 模型目录 + extra_model_paths.yaml | 扫描本地模型，按用途分组；详情显示架构/量化/触发词/引用；手动更正架构后保存 |  |
| R03 | 有草稿/模板/任务 | “引用诊断”列出缺失或换了子目录的模型；详情里显示被哪些草稿/模板/任务引用 |  |
| R04 | ComfyUI | 模型详情“用于当前工作流…”：显示将修改的节点，确认后入队运行，原工作流不变 |  |
| R07 | Windows + 网络 | 资源页“从 Git 地址安装…”安装一个小插件（可勾选依赖）；重启 ComfyUI 后被加载；禁用/启用/移除（移除前显示使用者，进入回收区） |  |
| R08 | 两个已登记模型目录（含跨盘） | 模型详情移动到另一已登记目录；ComfyUI 中模型名不变；跨盘时校验后删除原文件 |  |
| O08 | ComfyUI + 网络 | 补齐依赖弹窗为缺失节点填插件地址并安装，逐项报告；重启 ComfyUI 后重新诊断 |  |
| U05 | 网络 | 设置中渠道 beta/频率 daily：重启后后台检查一次（数据目录 `update-check.json`），有新版本时提示；manual 时不联网 |  |
| E10 | Windows + ComfyUI | 焦点在原生画布时 Ctrl+Enter 由映作队列运行（ComfyUI 自身队列不应出现重复提交）；Ctrl +/-/0 缩放编辑器；在 Comfy 中下载图片保存到数据目录 exports 并提示；LoadImage 选图对话框正常 |  |
| A01–A03 | ComfyUI | 任务完成后“作品与收藏”自动出现新图；设置 `output.prefixMode`（none/date/workflow/date-workflow）后输出落到 `output\映作\…` 子目录 |  |
| A04 | Windows | 作品查看器：滚轮缩放、拖动、0/1 键、打开/在文件夹中显示/导出原图/导出分享副本（去元数据） |  |
| A05–A08 | Windows | 收藏后收藏目录有副本；收藏板等高排列，窗口缩放后重排；取消收藏移到回收区；原图删除后收藏仍可见 |  |
| B03 | Windows | 下载 Actions 产物 yingzuo-windows：便携 exe 与 NSIS 安装包可双击运行；`映作.exe --yz-smoke=out.json` 输出 ok=true、驱动 better-sqlite3；中文路径下运行；安装版升级不覆盖 `%APPDATA%\映作\data` |  |
| B04 | — | 核对 artifacts.json 与 SHA256SUMS.txt 与产物一致；安装包未签名（SmartScreen 提示属预期） |  |


## PR11 审阅修复（第四轮，进行中）
逐项状态见 Grovebot开发进度.md 的 PR11 区块（`node tools/pr11.cjs render`）。可验收：
- D01/D02/PR11-R07(部分)/R08：tests/bindings-real.test.cjs + tests/fixtures/qwen21-gemma-api.json。
- D03/PR11-R09：tests/ui-tasks.test.cjs、task-service.test 中 PR11-R09。
- D05/PR11-R01：maint.test「恢复失败不启动服务」、task-service.test「暂停租约」。
- D04/PR11-R10（部分）：task-service.test D04、ui-tasks.test D04。
未完成项不在此列，不要按完成验收。
