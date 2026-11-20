'use strict';
// A03：日期／工作流输出前缀。只修改已登记保存节点的 filename_prefix（作用于任务快照副本，不改原工作流）；
// 目录名用“显示名_稳定ID前8位”，显示名改动不会让同一工作流散落到无关目录；未知保存类节点保持原设置并记录。
const {validateSegment} = require('../core/paths.cjs');

const REGISTERED_SAVE_NODES = Object.freeze({
  SaveImage: 'filename_prefix',
  SaveAnimatedWEBP: 'filename_prefix',
  SaveAnimatedPNG: 'filename_prefix',
  SaveVideo: 'filename_prefix',
  SaveWEBM: 'filename_prefix',
});
const MODES = ['none', 'date', 'workflow', 'date-workflow'];

function safeSegment(text, fallback) {
  let s = String(text ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60);
  if (!s || validateSegment(s)) s = fallback;
  return s;
}
const dateSegment = now => { const d = new Date(now); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

/** 计算目录前缀（不含原始文件名部分）。 */
function prefixDir({mode, workflowId, workflowName, now = Date.now(), base = '映作'}) {
  if (!MODES.includes(mode)) throw new Error(`未知的输出前缀模式：${mode}`);
  if (mode === 'none') return '';
  const parts = [safeSegment(base, 'yingzuo')];
  if (mode === 'date' || mode === 'date-workflow') parts.push(dateSegment(now));
  if (mode === 'workflow' || mode === 'date-workflow') {
    const id = String(workflowId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'noid';
    parts.push(`${safeSegment(workflowName, '未命名')}_${id}`);
  }
  return parts.join('/');
}

/**
 * 对 API 格式 prompt 的副本调整保存前缀。
 * 返回 {prompt, changed:[{nodeId,classType,before,after}], untouched:[{nodeId,classType,reason}]}
 */
function applyOutputPrefix(prompt, options) {
  const copy = structuredClone(prompt ?? {});
  const dir = prefixDir(options);
  const changed = [], untouched = [];
  for (const [nodeId, node] of Object.entries(copy)) {
    const type = node?.class_type;
    const key = REGISTERED_SAVE_NODES[type];
    if (key) {
      const before = node.inputs?.[key];
      if (typeof before !== 'string') { untouched.push({nodeId, classType: type, reason: '前缀由连线输入提供，保持原设置；实际位置以 history 为准'}); continue; }
      if (!dir) continue;
      const leaf = before.split(/[\\/]+/).filter(Boolean).at(-1) || 'ComfyUI';
      const after = `${dir}/${leaf}`;
      if (before.startsWith(`${dir}/`)) continue; // 幂等
      node.inputs[key] = after;
      changed.push({nodeId, classType: type, before, after});
    } else if (/save|export|output/i.test(String(type ?? '')) && !/preview/i.test(String(type))) {
      untouched.push({nodeId, classType: type, reason: '未登记的保存节点，保持原设置；实际位置以 history 记录为准'});
    }
  }
  return {prompt: copy, dir, changed, untouched};
}
module.exports = {REGISTERED_SAVE_NODES, MODES, prefixDir, applyOutputPrefix, safeSegment};
