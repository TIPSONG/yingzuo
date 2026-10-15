'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {buildPlan, findSources, detectManager} = require('../desktop/services/online/dependency-plan.cjs');

test('T08：诊断 → 补齐计划（模型按文件名去重、节点手动、LM Studio 模型不入 Comfy 目录）', () => {
  const plan = buildPlan({issues: [
    {code: 'unknown-node', nodeType: 'FooNode', nodeId: 1}, {code: 'unknown-node', nodeType: 'FooNode', nodeId: 2},
    {code: 'not-in-catalog', role: 'vae', value: 'sub/qwen_vae.safetensors', nodeId: 3, candidates: []},
    {code: 'not-in-catalog', role: 'vae', value: 'qwen_vae.safetensors', nodeId: 4, candidates: []},
    {code: 'not-in-catalog', role: 'language', value: 'gemma-x', nodeId: 5},
  ]});
  assert.equal(plan.models.length, 1); assert.deepEqual(plan.models[0].nodes, [3, 4]); assert.equal(plan.models[0].folder, 'vae');
  assert.equal(plan.nodes.find(n => n.nodeType === 'FooNode').count, 2);
  assert.match(plan.nodes.find(n => n.nodeType.includes('gemma-x')).reason, /LM Studio/);
});
test('T08：来源只接受同名文件', async () => {
  const hf = {search: async () => ({items: [{id: 'a/b'}, {id: 'c/d'}, {id: 'bad/x'}]}), detail: async id => { if (id === 'bad/x') throw new Error('403'); return {id, revision: 'r1', license: 'mit', files: id === 'a/b' ? [{path: 'vae/qwen_vae.safetensors', size: 5, sha256: 's'}] : [{path: 'qwen_vae_v2.safetensors', size: 5}]}; }};
  const s = await findSources(hf, 'qwen_vae.safetensors');
  assert.deepEqual(s.map(x => [x.repo, x.path, x.revision]), [['a/b', 'vae/qwen_vae.safetensors', 'r1']]);
});
test('R06：只读探测 Manager 目录、版本与 CLI', t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-mgr-')); t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  assert.equal(detectManager(d).installed, false);
  fs.mkdirSync(path.join(d, 'ComfyUI-Manager')); fs.writeFileSync(path.join(d, 'ComfyUI-Manager', 'pyproject.toml'), 'name = "comfyui-manager"\nversion = "3.30.4"\n'); fs.writeFileSync(path.join(d, 'ComfyUI-Manager', 'cm-cli.py'), '');
  const m = detectManager(d); assert.equal(m.version, '3.30.4'); assert.equal(m.cli, 'cm-cli.py');
});
