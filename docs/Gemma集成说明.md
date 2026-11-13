# Gemma 4 提示词润色

启动 ComfyUI 和 LM Studio，然后在润色节点中设置本地服务地址和已安装的模型。

在 ComfyUI 左侧“工作流”中打开：

- **Gemma 4 - Prompt Enhancer**：只润色并显示结果，适合先检查文字。
- **Gemma 润色文生图**：中文要求 → Gemma 润色 → Qwen 出图。
- **Gemma 润色多图编辑**：前两张参考图和中文编辑要求 → Gemma 润色 → Qwen 编辑。

修改“1. 输入你的要求（中文即可）”，然后点运行。润色结果可在“3. 润色后的提示词”查看。
生成结果保存在 ComfyUI 配置的输出目录。

## 需要知道的参数

- `style=minimal enhancement`：尽量保留你指定的画风、服装、姿势，不擅自增加电影风格。
- `enable_llm=false`：直接使用原始提示词，不调用 Gemma。
- `cache_buster`：改变数字后强制重新润色；只改绘图 seed 不一定重新润色。
- `release_vram=true`：润色前释放 ComfyUI 已加载模型，润色后卸载本次调用的 LM Studio 模型实例，给 Qwen 留显存。下一次需要时会重新加载。若同一 Gemma 实例还用于其他聊天，也会被卸载；需要保留它时关闭此选项并留意显存。
- `disable_thinking=true`：关闭 Gemma 推理过程，只输出润色结果。
- `context_length=8192`：为润色单独加载 8192 token 上下文。

编辑工作流中，Gemma 节点最多读取两张参考图。Qwen 仍可使用更多参考图，但第三张及之后不会传给此 Gemma 节点，请在文字中明确用途。
润色不保证更符合参考图；复杂编辑建议先检查输出，必要时关闭润色。

## 安装来源

节点来自 [LM Studio Prompt Enhancer](https://github.com/AllenCraigBarnard/comfyui-lmstudio-prompt-enhancer)。可用参数取决于已安装的节点版本。更新前请保留本地自定义修改。
