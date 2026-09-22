# Gemma 4 提示词润色

双击 `Start-ComfyUI-with-Gemma.bat`，会启动 LM Studio 的本地服务与 ComfyUI。
只连接 `http://127.0.0.1:1234/v1`，使用现有的 HauhauCS Gemma 4 12B Q4_K_M，不重复下载模型。

在 ComfyUI 左侧“工作流”中打开：

- **Gemma 4 - Prompt Enhancer**：只润色并显示结果，适合先检查文字。
- **Qwen 2.1 Q6_K + Gemma - Text to Image**：中文要求 → Gemma 润色 → Qwen 出图。
- **Qwen 2.1 Q6_K + Gemma - Multi Image Edit**：前两张参考图和中文编辑要求 → Gemma 润色 → Qwen 编辑。

修改“1. 输入你的要求（中文即可）”，然后点运行。润色结果可在“3. 润色后的提示词”查看。
生成结果在 `output/Qwen_Gemma`。

## 需要知道的参数

- `style=minimal enhancement`：尽量保留你指定的画风、服装、姿势，不擅自增加电影风格。
- `enable_llm=false`：直接使用原始提示词，不调用 Gemma。
- `cache_buster`：改变数字后强制重新润色；只改绘图 seed 不一定重新润色。
- `release_vram=true`：润色前释放 ComfyUI 已加载模型，润色后卸载本次调用的 LM Studio 模型实例，给 Qwen 留显存。下一次需要时会重新加载。若同一 Gemma 实例还用于其他聊天，也会被卸载；需要保留它时关闭此选项并留意显存。
- `disable_thinking=true`：关闭 Gemma 推理过程，只输出润色结果。
- `context_length=8192`：为润色单独加载 8192 token 上下文，避免沿用 LM Studio 的 26 万 token 设置。

编辑工作流中，Gemma 节点最多读取两张参考图。Qwen 仍可使用更多参考图，但第三张及之后不会传给此 Gemma 节点，请在文字中明确用途。
润色不保证更符合参考图；复杂编辑建议先检查输出，必要时关闭润色。

## 安装来源与本地调整

节点来自 https://github.com/AllenCraigBarnard/comfyui-lmstudio-prompt-enhancer ，名称为 **LM Studio Prompt Enhancer**。
原来的 ComfyUI-GGUF（leejet 分支）继续加载 Qwen；city96 版本不负责语言模型提示词生成，因此没有重复安装。

本地对润色插件增加了 `release_vram`、`disable_thinking`、`context_length` 三个可选设置，并在输出为空时明确报错。
这些是本地改动，更新插件时需要保留。补丁备份：`D:/agent/qwen-deployment/lmstudio-local.patch`。

验证记录保存在 `D:/agent/qwen-deployment/gemma-*-result.json`。
