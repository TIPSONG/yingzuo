# 映作 PR #11：代码与截图审阅清单

审阅日期：2026-10-13。供 Grovebot / 小 grok 修复。人工验收栏全部留空。

## 1. 结论与固定依据

**目前有 6 项 P1 阻塞问题、8 项 P2 需改问题、1 项 P3 证据完善任务。保持草稿，不合并。** 已有多轮修复确实落地；本轮关注剩余的生产调用链、恢复边界和 UI 回归，不要求重做原 82 项，不扩展产品范围。

| 项目 | 本轮核对结果 |
| --- | --- |
| PR | [TIPSONG/yingzuo #11](https://github.com/TIPSONG/yingzuo/pull/11)，草稿、打开、未合并 |
| 分支 | `feat/grovebot-impl` → `feat/p0-desktop-integration` |
| 审阅提交 | `d5cca174279470e98ed4c70b94eb9e8f2707adbd`，下文简称 d5cca17 |
| base | `31d8d2b89e5f0486f990b4ca692d0fe3c9909c97` |
| 代码范围 | 核对相对 base 的改动范围，重点追踪任务/密钥、维护/恢复、表单、图包、资源、Worker、设置和桌面 UI；并对 f493fce 之后的 C01–C09 与 UI 增量逐项检查。不是穷尽安全审计 |
| 截图范围 | `docs/development/ui-shots/` 的 default / nasa / light 各 10 张，共 30 张，全部查看 |
| Windows 回归 | [run 38401409102](https://github.com/TIPSONG/yingzuo/actions/runs/38401409102)：Node 339 项，338 通过、1 跳过、0 失败；Python 7 项通过 |
| Linux 回归 | 同一精确 head 的 Ubuntu job 成功 |
| Windows 打包 | [run 38401409138](https://github.com/TIPSONG/yingzuo/actions/runs/38401409138)：成功；NSIS / portable、自检及隔离业务初始化通过 |
| 打包产物 | [yingzuo-windows，artifact 11815367967](https://github.com/TIPSONG/yingzuo/actions/runs/38401409138/artifacts/11815367967)；自检实际使用 better-sqlite3，sharp 与 worker 检查成功 |
| 本轮本机检查 | 静态审阅 + 5 个隔离模块探针，触发 6 个缺口；没有启动 Electron/ComfyUI/LM Studio 或生成图片，没有修改功能代码、推送、发布 PR 评论或合并 |

截图说明明确写着“静态托管 + Puppeteer + 演示 IPC 数据”。它们证明所截状态的外观，不能证明 WebContentsView、窗口按钮、系统明暗事件、真实生成和文件恢复可用。隔离模块探针也不算 Windows 应用人工验收，因此不填写任何人工验收结果。

源码为固定提交的独立副本；原本地工作区及已有规划文件保留。下面的行号都对应 d5cca17，开发者应从该提交或其后续提交核对，不用本机旧分支的行号套用。

## 2. 需改项总表

P1：先修，涉及重启恢复、密钥或运行环境保护；P2：功能或可用性缺口，建议在本轮程序收尾解决；P3：补足审阅证据。严重程度不代表人工验收或合并许可。

| ID | 严重程度 | 问题 | 依据 | 人工验收 |
| --- | --- | --- | --- | --- |
| RV01 | P1 阻塞 | 脱敏后的草稿与索引哈希不一致，保存成功却无法重启读取 | 隔离复现 | |
| RV02 | P1 阻塞 | forceInput 被计入 widget 序列，密钥漏处理且普通字段被清空 | 隔离复现 | |
| RV03 | P1 阻塞 | 未进入 API 执行图的节点密钥仍写入任务 UI 快照 | 隔离复现 | |
| RV04 | P1 阻塞 | HTTP 探测失败被当作后端已停止，维护/移动保护失效 | 隔离复现 | |
| RV05 | P1 阻塞 | 恢复前 ensureLayout 重建目标目录，阻止中断后的继续恢复 | 隔离复现 | |
| RV06 | P1 阻塞 | 手动停止/释放显存绕过 starting、外部任务及统一环境 guard | 静态调用链 | |
| RV07 | P2 | 参数覆盖后没有再校验最终表单值，批量可绕过自定义范围 | 隔离复现 | |
| RV08 | P2 | 快捷使用强制传空 references，忽略当前参考图及缺失检查 | 静态调用链 | |
| RV09 | P2 | 设置的模板目录没有被模板仓库采用 | 静态调用链 | |
| RV10 | P2 | Worker 临时文件没有实际登记，取消/关闭后可能遗留大文件 | 静态调用链 | |
| RV11 | P2 | 浅色导航选中项白字配浅底，对比度约 1.25:1 | 截图 + CSS | |
| RV12 | P2 | NASA + 浅色组合只改部分组件，弹窗/空状态/选中卡配色冲突 | CSS 调用范围推导 | |
| RV13 | P2 | 切主题/皮肤重建整个设置表单，丢掉未保存输入 | 静态 UI 调用链 | |
| RV14 | P2 | queue.maxBatch 可保存，但预览、界面和执行仍固定为 100 | 静态调用链 | |
| RV15 | P3 | 三套截图数据/时机不一致，不能确认当前工具栏与完整页面状态 | 截图对照 | |

## 3. 阻塞问题与建议改法

### RV01 — P1：对实际落盘图计算哈希

位置：[desktop/workspace-store.cjs:90–93][rv01]，读取校验在该文件第 67 行。

`body` 对 `secureGraph(graph)` 序列化，但元数据保存 `graphHash(graph)`，即脱敏前的内存图哈希。只要密钥替换发生，保存文件与索引就不匹配。重启时 readWorkspace 抛错，编辑器会把工作区读为失败状态；不是密钥缺失造成的提示。

隔离结果：`reopened:false`，错误为“草稿校验不一致”；索引 hash `4526e390…`，实际文件 hash `1f5bfb53…`。样本只用了虚构文本与凭据引用，没有用户凭据。

**改法：** 每个标签先生成一次 `diskGraph`，序列化和 graphHash 都使用它；内存图及用于编辑的 revision 保持独立。不能删除 readWorkspace 的完整性检查来掩盖问题。为此前已生成的错配草稿提供受控修复：保留原索引/文件，只有能核实旧内存/脱敏转换关系时修复索引，无法核实的保留并报错。

开发回归：使用真实 GraphStoragePolicy + 虚构加密后端，走 writeWorkspace → 新实例 readWorkspace → resolveInMemory；含两个标签、子图、缺凭据和被篡改文件。断言正常重开，真正篡改仍被拒绝。

### RV02 — P1：敏感字段位置不能只按 INPUT_TYPES 顺序猜

位置：[shared/graph-storage-policy.cjs:21–28][rv02] 与第 46 行。`isWidgetDef` 只看标量类型，不排除 `forceInput:true`，但这类输入并不占一个正常创建的 UI widget 值。密钥位置会错位。

隔离样本：输入定义为 `prompt(STRING, forceInput)`、`api_key(STRING,password)`、`model(STRING)`；widgets_values 实际为 `[虚构密钥, 模型名]`。策略命中 index 1 并当作 api_key，导出结果仍包含 index 0 的密钥，却清空模型名。本机已有 Gemma 节点源码也声明了 prompt 的 forceInput；该语法不是臆造的 API。

**改法：** 优先使用实际编辑器提供的 widget 名称/序列化索引与敏感属性；如果从 object_info 重建，必须处理 forceInput、已转为输入的 widget、control_after_generate 和自定义序列化。无法确定对应关系时不能清空一个猜测的位置后宣称安全。当前主进程只提供 taskService 缓存的 object_info，也要解决首次保存/离线时尚无缓存的识别边界；不能要求先跑一次任务才有安全保存能力。

开发回归：上述 forceInput 示例、输入转换前后、seed 控制位、任意格式的虚构密钥、首次保存、离线与子图。核对“密钥已移除/引用化”及“提示词/模型选择没有被误删”两个后置条件。

### RV03 — P1：任务快照也必须经过 UI 图存储政策

位置：[desktop/services/task-service.cjs:167–180][rv03]。redactSnapshot 只扫描 API prompt；如果 `r.refs.length === 0`，直接返回原 snapshot。即使有 API 密钥，也只按那些已找到的明文替换其他 JSON。

未连接到输出的 LLM 节点仍会出现在 UI 图，但不进入 API 执行图。隔离样本的未使用节点放了虚构 `sk-…` 密钥：普通任务成功入队，实际持久化 snapshot.uiGraph 仍含该字符串。已有 GraphStoragePolicy 能识别这种格式，却没有接入此入口。应用备份还复制 task-snapshots，而 secret-migration 只扫描草稿/关闭归档/模板，因而同一泄漏可进入备份。

**改法：** 注入统一的图存储政策，所有 enqueue/enqueueGroup/retry 快照的 UI 图都处理，不根据 API 是否命中决定跳过；API 输入、表单 defaultValue/values 等快照附带字段也采用相同敏感字段约束。旧快照采用新内容地址 + 数据库引用原子迁移，保持任务 lineage 和校验完整，不直接改旧文件而不改 hash。备份前检查覆盖全部实际复制的敏感存储来源。

开发回归：执行图无密钥但 UI 含未连接/静音/旁路节点、批量、重试、图包恢复的表单默认值；递归检查实际快照与备份文件，不能只测 helper 返回值。

### RV04 — P1：探测失败不是“确认服务未运行”

位置：[desktop/services/maintenance-service.cjs:52–66][rv04]。system_stats 超时、网络错误或非成功 HTTP 都得到 `running:false`；此时甚至不调用 verifyOwned。所有环境操作随后按“没有运行中的服务”继续。

隔离复现模拟“进程仍在、HTTP 暂时超时”，移动恢复实际删除了虚构源文件并返回 completed，ownershipChecks 为 0。该问题也影响更新、恢复和普通模型移动；不能通过外部队列的二次检查解决，因为在此之前就被跳过了。

**改法：** 区分 `confirmed-stopped / running / unknown`，综合登记进程身份、进程存活与端口探测。HTTP 失败保留 unknown；只有明确确认停止才允许忽略服务。unknown 时阻止维护/移动，保留 journal 与现场。对进程核实成功但 HTTP 不可用的 owned 实例，可以按既有流程停止并等待真实退出，再继续；不能未经停止就在它仍使用的目录里操作。

开发回归：system_stats 超时/500、端口可连接但身份未知、登记 PID 活着但 HTTP 不通、真正已退出。断言 unknown 不发生 apply/删模型；真正停止后仍可操作。

### RV05 — P1：恢复 bootstrap 不得创建正在恢复的目录

位置：[desktop/entry.cjs:22][rv05]，`desktop/repositories/data-root.cjs:27–30`；随后 RestoreEngine._swap 检查目标必须不存在。

当恢复在 preserve 后中断，drafts/templates 等目标已搬为 scene。下次 entry 调用 ensureLayout，会先 mkdir 这些目标。resume 保留 preserve=done，继续到 swap 时因“目标仍存在”失败。独立 recovery 窗口已经接通，但这个恢复前的写入仍会破坏继续恢复的前提。

隔离复现：中断后 drafts 目标不存在；执行与 entry 相同的 ensureLayout 后目标被重建；resume 报“目标仍存在，无法切换”。

**改法：** 拆出无副作用的路径布局描述函数；pending / journal 的读取与恢复执行使用它，恢复成功后才 ensureLayout 并启动 normal。恢复模式只创建必需且不属于受恢复目标的控制目录。不要在 _swap 里无条件删除目标来迁就这次 mkdir；要保留用户后续放入的真实冲突内容。异常路径也不能因为构造 layout 失败就默默转入普通 main。

开发回归：通过 entry 等价 bootstrap 覆盖 stage/preserve/carry/swap/verify 的中断重开；不能只调用恢复引擎来测。目标路径中新放入的文件仍触发冲突，自动创建的空目录不再发生。

### RV06 — P1：停止/释放显存入口使用同一保护

位置：[desktop/services/api.cjs:74–84][rv06]。两入口只检查本应用 activeTasks，未暂停提交、等待 starting、取环境锁或检查后端其他来源任务。stopComfy 的 owned 检查只能证明服务归属，不能证明其中没有原生画布/其他程序的任务。

因此任务还处于“查询后端→准备启动”时，可以通过服务页停止它；owned 后端正在执行外部任务时也能停止。freeComfyMemory 直接发 unload_models，连外部启动的服务也会受影响。维护事务已有的 guard 没有覆盖这些生产入口。

**改法：** 复用环境 guard，暂停并等待 active/starting 消退，在锁内重新检查 ownership 与后端 queue，未知或有外部任务时拒绝。释放显存也要受 GPU/任务状态约束。退出流程一并核对，不把“owned 服务”当成其中所有任务均归本应用；若产品允许影响全部任务，必须做与精确取消分开的明确操作语义，不沿用当前只停本应用实例的提示冒充任务级保护。

开发回归：延迟后端查询期间停止/释放显存，owned 后端只有外部任务，等待锁期间服务身份改变；观察实际 stop/free 调用和租约释放。

## 4. 功能与 UI 需改项

### RV07 — P2：校验最终提交值，而非覆盖前的图

位置：[desktop/services/task-service.cjs:256–258][rv07]，批量在第 278–283 行同样先 checkFormForRun，再 B.applyValues。

隔离结果：表单 steps 最大值 30，当前图 steps=20；普通 values.steps=99 与批量 variations.steps=[20,99] 都成功入队。planBatch 调用只拿类型和 label，没有表单范围；API 的 spec.params 也会在后面覆盖值。

**改法：** 完成 formValues、普通绑定、批量变化、采用润色等全部覆盖后，对最终 prompt 验证映射、类型/范围/选项，再统一提交；整组先全量验证，任一项无效整组零入队。快照记录实际最终值，不能记录覆盖前的表单值。

开发回归：上述 20→99 场景，enum 不存在值、params 覆盖、表单值与批量值冲突；观察 tasks 数量与实际快照，而非只测 planBatch。

### RV08 — P2：快捷使用保留当前参考图关系

位置：[desktop/services/maintenance-service.cjs:314][rv08]。快捷使用明确传 `references:[]`，refsForRun 又将任何显式数组直接返回，所以不会使用当前已选参考图，也不会报丢失素材。

用户在多图编辑里选了图 A，再“用于当前工作流”换模型，生成可能沿用图中旧的后端文件名而非 A。当前 UI 只保存参考关系，并不会把本机选图提前上传写入所有 API 节点，空数组并不是“照常使用”。

**改法：** 不传 references，让统一提交服务按发起标签解析，或传该标签固定 revision 的实际关系；保留缺失检查和上传。资源确认对话框开始就固定 tabId/revision，等待期间切标签不能把确认过的计划用于另一份图。

开发回归：图节点旧文件名 + 当前关系选图 A，快捷换模型后任务 references 含 A，上传结果正确；A 缺失时不入队；确认期间切标签不串图。

### RV09 — P2：模板目录配置需要真正接线

位置：[desktop/services/template-service.cjs:13][rv09]；config-repo.derived 第 150 行却返回 `c.paths.templates || layout.templates`。设置页显示“模板目录”，打开目录使用派生路径，模板仓库、缩略图和备份来源仍使用 layout.templates。

**改法：** 定义明确生效时机，并让仓库读写、缩略图、导入/导出和备份引用使用同一实际存储根。切目录要提供索引/迁移策略，拒绝直接让旧 SQLite 中的相对 graph_ref 指向一个空新根。当前不支持移动时，就禁用该设置并说明固定位置，不能保存一个实际无效的目录。

开发回归：配置非默认根后创建/打开/重启/生成缩略图/备份，核对实际文件位置与引用；旧模板仍可找回。自定义收藏等目录也在备份范围清单中明确标为内部或外部，避免 UI 地址与备份范围不一致。

### RV10 — P2：Worker 临时产物清理未接到真实任务

位置：[desktop/core/worker-pool.cjs:15–25][rv10]；`desktop/core/workers/file-worker.cjs:43`。

池只清 `job.temps`，默认空数组。copyFile 在 worker 内才生成 `.yz-copy-<pid>-<time>`，模型移动、备份与收藏的调用没有传 temps；图包导出临时名也没有登记。terminate 不执行 worker 内 catch，所以取消或退出会留下无法被移动 journal 识别的 `.yz-copy-*` 大文件。即使传了 temps，当前删除发生在确认 worker 退出前，Windows 下可能仍有打开句柄，失败被忽略。

**改法：** 主进程预先分配/登记临时路径并传 worker，或通过握手返回登记；等待该 worker 真实终止、句柄关闭后清理。失败清理写入可恢复记录，下次启动只清理本应用登记的未提交产物，不按宽泛文件名删除。共享池关闭期间晚到结果不能再创建新池写数据。

开发回归：真实 file-worker 长复制与图包写入中取消、close、worker crash；Windows CI 检查已提交目标不受影响，登记临时文件消失或有可追踪的待清理记录。此前 closing/closed 状态修正应保留。

### RV11 — P2：浅色导航选中态文字几乎消失

位置：[desktop/ui/shell.css:722–725][rv11]；证据为全部 light 截图，例如 [light-home.png][shot-light-home]、[light-settings.png][shot-light-settings]。

通用 `[data-theme="light"] button.active` 把 `.nav.active` 改成 `#f4f9e8`，导航背景却仍是浅色叠层。按 CSS 色值计算，背景约 `#dbe1d1`，对比度约 1.25:1。截图中的“首页/设置”等选中导航明显比非选中项更难读。

**改法：** 限定白字规则到有实色强调背景的按钮，排除 nav/模式/主题卡；为各类选中态使用独立前景 token。检查焦点和 hover，不用加深整个浅色界面来解决一个 selector。

开发回归：浅色首页与设置选中项的 computed color/背景组合，文字对比度目标至少 4.5:1；三套皮肤的 hover/focus/active 截图。

### RV12 — P2：NASA + 浅色的组件配色不完整

位置：[desktop/ui/shell.css:808–818][rv12]、第 921–939 行与第 968–976 行。

此组合将 text 改为深色，但 modal、task、node-fields、empty-state 仍使用深蓝背景；light 覆盖只处理 card/row/entry/fieldset。选中的 theme-option 小字又用 `#ffffff !important`，在浅色卡片上不匹配。body/aside/page-head 的深色渐变也没有随 light token 切换。

这是当前 CSS 覆盖范围能推导出的缺口，现有 30 张图不包含 NASA-light，不能写成“已经看过 NASA-light 真机”。跟随系统在白天变浅色也会进入该组合。

**改法：** 将所有组件背景与前景成对使用明暗 token，补全 NASA-light；若 NASA 明确只支持深色，则选择时明确强制/锁定深色，不呈现一个可保存却不可读的组合。不要只增加几条 !important。

开发回归：default 与 NASA × dark/light/system；至少包含设置选中卡、弹窗、任务卡、空状态、主表单。系统 change 事件应实际触发主题转换，不能只改 dataset 生成图。

### RV13 — P2：切外观会丢掉设置草稿

位置：[desktop/ui/shell.js:280–304][rv13]；renderSettings 第 240 行用已保存 config 重建整个 innerHTML。

用户先输入 ComfyUI 目录/Python/API 地址但尚未点击保存，再点浅色或 NASA：处理器只保存 ui，随后 renderSettings 从旧 config 重建输入框，前面输入被静默丢掉。选择路径或保存在线凭据后也有同类重建。

**改法：** 设置页保存独立 draftConfig 与 dirty 字段；外观即时预览/保存不能覆盖其他草稿。也可只更新外观选择区域而不重建全表单。外观保存失败要恢复已保存状态或保留清楚的未保存状态；快速切换结果应按最新操作收敛。

开发回归：编辑多个字段→切主题/皮肤→继续编辑→保存，之前内容保持；切换失败与迟到响应；路径选择和凭据按钮不抹掉其他字段。

### RV14 — P2：批量上限设置是无效配置

位置：[desktop/services/task-service.cjs:266–274][rv14]；`desktop/ui/tasks.js:92,100`；config 校验允许 queue.maxBatch 为 1–1000。

预览 max 固定 100，planBatch 不传配置 max，整组检查固定 `>100`，弹窗输入与提示也写死 100。用户设置 10 仍能提交更多，设置 200 又不能提交 101。它与表单约束 RV07 是不同问题。

**改法：** 后端提供有效上限作为唯一来源，预览、整组规划及 UI 都读取它；若确实只支持硬上限 100，则配置允许范围和说明也统一，低于 100 的用户限制仍需执行。

开发回归：设置 10 时 11 项整组拒绝、10 项成功；设置较高值时行为与说明一致；修改设置后的下一个预览立即更新。

### RV15 — P3：重新生成一致且可追溯的视觉证据

位置：[docs/development/ui-shots/README.md][rv15]，以及 30 张已查看的截图。

default/NASA 的首页是简化服务卡，而 light 是实际 shell.js 的完整卡；NASA 设置仍把“默认皮肤”显示为选中。nasa-create-start 的旧运行提示落在状态条边缘，nasa-create 却是新网格状态。当前代码已有工具栏自动网格，因此不能仅凭旧截图把“仍然重叠”定为当前功能缺陷。设置页截图也只覆盖滚动区域的顶部，凭据/行为/保存结果未呈现。

**改法：** 把静态捕获脚本、夹具与等待条件放进仓库，使用同一提交、同一数据和完成后的真实渲染函数；从配置 stub 选择主题/皮肤，而非直接改 dataset 绕过设置状态。记录代码 head、viewport/DPR、页面/状态与是否静态。保留空状态外，再补非空列表、标签/表单、错误/确认弹窗、长文件名、最小窗口与缩放状态；设置的滚动内容可分段截图。标题栏截图只是外观，按钮/托盘/焦点仍留到人工验收。

本项是证据完善，不新增产品功能，也不能把新增静态截图填入人工验收列。

## 5. 隔离证据与截图覆盖

自动探针在本机 `D:/agent/reviews/yingzuo-pr11-d5cca17/review-probes.cjs`，结果为同目录 `review-probe-results.json`。只读固定源码，所有文件/SQLite/假模型均位于新建的 probe-data 子目录，HTTP/编辑器使用替身；没有触碰真实模型、图片、服务或密钥。

| 探针 | 观察到的后置状态 | 对应项 | 人工验收 |
| --- | --- | --- | --- |
| secured-workspace-round-trip | 保存后 readWorkspace 失败，索引/磁盘 hash 不同 | RV01 | |
| force-input-widget-offset | api_key 命中模型位置；原密钥仍导出，模型被清空 | RV02 | |
| task-ui-secret-and-final-form-constraints | 持久化 UI 快照仍有虚构密钥；steps=99 入队；批量 [20,99] 均入队，form max=30 | RV03、RV07 | |
| failed-service-probe-model-recovery | HTTP 失败时未查 ownership，源文件被删除并返回 completed | RV04 | |
| layout-created-before-restore-resume | bootstrap 重建目标；继续恢复报目标存在 | RV05 | |

截图的 home/create/create-start/templates/online/assets/resources/queue/services/settings，各自 default/nasa/light 三版均已查看。RV11 为直接可见问题；RV12 是未覆盖组合的 CSS 问题；RV15 记录证据局限。没有依据这些空状态判断真实节点图被删除，也没有将界面截图当作窗口行为通过。

## 6. 给 Grovebot 的修复顺序与交付

先 RV01/RV05：恢复与重启主链；同时修 RV02/RV03：完整密钥边界。再 RV04/RV06：运行环境保护。随后 RV07–RV10/RV14：最终值校验、参考关系、有效配置和 Worker；最后 RV11–RV13/RV15：UI 与证据。按每个问题的触发场景建立会失败的开发回归后修正，不以新增几个 helper 或增加测试总数代替真实调用接线。

继续在同一草稿 PR #11 推送；不要合并 PR、不要 force-push、不要动 main，不开新的并行 PR，不扩展产品范围。交付一张 RV01–RV15 对照表，记录提交、修改文件、开发回归结果与仍需外部契约确认的限制；人工验收列保持空白。提供最终精确 head 的 Windows/Linux CI、打包产物与同 head 的截图说明；本轮已确认的绿色结果不替代下一提交的检查。

可复制给 bot：

> 请按《PR11代码与截图审阅-d5cca17.md》核对并修复 RV01–RV15。优先修脱敏草稿哈希、forceInput 密钥错位、未执行节点密钥进入任务快照、HTTP 未知状态被当作停止、恢复 bootstrap 重建目标以及停止/释放显存的统一保护；再完成最终表单校验、快捷使用参考图、模板目录与批量上限配置、Worker 临时产物清理，以及浅色导航/NASA-light/设置草稿保留。最后重建同一代码版本与同一数据的截图证据。已有 C01–C09 的成果保留，不重写整个项目。程序与隔离开发回归由你做，人工验收栏继续留空。继续推草稿 PR #11，不合并、不扩展范围。

[rv01]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/desktop/workspace-store.cjs#L90
[rv02]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/shared/graph-storage-policy.cjs#L21
[rv03]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/desktop/services/task-service.cjs#L167
[rv04]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/desktop/services/maintenance-service.cjs#L52
[rv05]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/desktop/entry.cjs#L22
[rv06]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/desktop/services/api.cjs#L74
[rv07]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/desktop/services/task-service.cjs#L256
[rv08]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/desktop/services/maintenance-service.cjs#L314
[rv09]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/desktop/services/template-service.cjs#L13
[rv10]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/desktop/core/worker-pool.cjs#L15
[rv11]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/desktop/ui/shell.css#L722
[rv12]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/desktop/ui/shell.css#L808
[rv13]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/desktop/ui/shell.js#L280
[rv14]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/desktop/services/task-service.cjs#L266
[rv15]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/docs/development/ui-shots/README.md
[shot-light-home]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/docs/development/ui-shots/light-home.png
[shot-light-settings]: https://github.com/TIPSONG/yingzuo/blob/d5cca174279470e98ed4c70b94eb9e8f2707adbd/docs/development/ui-shots/light-settings.png
