"""Read filenames and Python AST only; never import nodes or launch model services."""
import ast
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMFY = Path('D:/agent/ComfyUI')
ROLES = {'diffusion_models': 'diffusion', 'unet': 'diffusion', 'text_encoders': 'encoder', 'clip': 'encoder', 'vae': 'vae', 'loras': 'lora', 'checkpoints': 'checkpoint'}
models = []
for directory, role in ROLES.items():
    for path in (COMFY / 'models' / directory).rglob('*'):
        if path.is_file() and path.suffix.lower() in {'.gguf', '.safetensors', '.ckpt', '.pt', '.pth', '.bin'}:
            models.append({'id': f'{directory}/{path.relative_to(COMFY / "models" / directory).as_posix()}', 'value': path.relative_to(COMFY / 'models' / directory).as_posix(), 'role': role, 'format': path.suffix[1:].lower(), 'folder': f'ComfyUI/models/{directory}', 'evidence': '本机文件', 'bytes': path.stat().st_size})

# API identifiers come from this environment's existing working configuration,
# not from a guessed filename-to-model-id conversion.
gemma = Path('D:/agent/localspace/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf')
if gemma.is_file():
    models.append({'id': 'lmstudio-gemma12b', 'value': 'gemma4-12b-qat-uncensored-hauhaucs-balanced@q4_k_m', 'filename': gemma.name, 'role': 'language', 'format': 'gguf', 'folder': 'LM Studio · 已有本地配置', 'evidence': '文件存在；API 标识来自已有配置，服务未核验', 'bytes': gemma.stat().st_size})

node_types = {'Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode'}
paths = [COMFY / 'nodes.py', *(COMFY / 'comfy_extras').glob('*.py'), *(COMFY / 'custom_nodes').rglob('*.py')]
for path in paths:
    try:
        tree = ast.parse(path.read_text(encoding='utf-8-sig'))
    except (SyntaxError, UnicodeError):
        continue
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'NODE_CLASS_MAPPINGS' for t in node.targets) and isinstance(node.value, ast.Dict):
            node_types.update(key.value for key in node.value.keys if isinstance(key, ast.Constant) and isinstance(key.value, str))
        if isinstance(node, ast.keyword) and node.arg == 'node_id' and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            node_types.add(node.value.value)

catalog = {'checkedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'source': '本机标准模型目录、节点源码定义与已有 LM Studio 配置快照', 'runtimeChecked': False, 'models': models, 'nodeTypes': sorted(node_types)}
(ROOT / 'compatibility-catalog.js').write_text('const CompatibilityCatalog = ' + json.dumps(catalog, ensure_ascii=False, indent=2) + ';\nif (typeof module !== "undefined" && module.exports) module.exports = CompatibilityCatalog;\n', encoding='utf-8')
print(f'Snapshot: {len(models)} models, {len(node_types)} node definitions; no runtime validation.')
