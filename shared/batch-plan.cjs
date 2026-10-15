'use strict';
// R19：批量原子规划（纯函数）。先展开并校验全部任务，任何一项无效则整体拒绝（不返回部分计划），
// 调用方据此在同一事务中登记任务组。
const DEFAULT_MAX = 100;

/**
 * spec: {prompts?: string[], seeds?: number[], count?, seedStart?, variations?: {[bindingId]: any[]}}
 * bindings: {[bindingId]: {type:'int'|'float'|'string'|'enum'|'bool', min?, max?, options?, label?}}
 * 返回 {ok:true, total, items:[{prompt, seed, values}]} 或 {ok:false, total, errors:[{index?, field, message}]}
 */
function planBatch(spec = {}, bindings = {}, {max = DEFAULT_MAX, requirePrompt = false} = {}) {
  const errors = [];
  const prompts = spec.prompts == null ? [null] : spec.prompts;
  if (!Array.isArray(prompts) || !prompts.length) errors.push({field: 'prompts', message: '提示词列表为空。'});
  else prompts.forEach((p, i) => { if (p !== null && (typeof p !== 'string' || (requirePrompt && !p.trim()))) errors.push({field: 'prompts', index: i, message: `第 ${i + 1} 条提示词无效。`}); });
  let seeds;
  if (Array.isArray(spec.seeds)) { seeds = spec.seeds; if (!seeds.length) errors.push({field: 'seeds', message: 'seed 列表为空。'}); }
  else { const n = spec.count ?? 1; if (!Number.isInteger(n) || n < 1) errors.push({field: 'count', message: '数量必须是正整数。'}); seeds = Array.from({length: Number.isInteger(n) && n > 0 ? n : 0}, (_, i) => spec.seedStart == null ? null : spec.seedStart + i); }
  seeds.forEach((s, i) => { if (s !== null && !(Number.isSafeInteger(s) && s >= 0)) errors.push({field: 'seeds', index: i, message: `第 ${i + 1} 个 seed 无效：${s}`}); });
  const vars = Object.entries(spec.variations ?? {});
  for (const [id, list] of vars) {
    const b = bindings[id];
    if (!b) { errors.push({field: id, message: `参数 ${id} 不存在或映射已失效。`}); continue; }
    if (!Array.isArray(list) || !list.length) { errors.push({field: id, message: `${b.label ?? id} 的变化列表为空。`}); continue; }
    list.forEach((v, i) => { const m = checkValue(v, b); if (m) errors.push({field: id, index: i, message: `${b.label ?? id} 第 ${i + 1} 个值${m}`}); });
  }
  const total = (Array.isArray(prompts) ? prompts.length : 0) * seeds.length * vars.reduce((n, [, l]) => n * (Array.isArray(l) ? l.length : 0), 1);
  if (total > max) errors.push({field: 'total', message: `批量共 ${total} 个任务，超过上限 ${max}。`});
  if (errors.length) return {ok: false, total, errors};
  let combos = [{}];
  for (const [id, list] of vars) combos = combos.flatMap(c => list.map(v => ({...c, [id]: coerce(v, bindings[id])})));
  const items = [];
  for (const prompt of prompts) for (const seed of seeds) for (const values of combos) items.push({prompt, seed, values});
  return {ok: true, total, items};
}
function checkValue(v, b) {
  switch (b.type) {
    case 'int': case 'float': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return '不是有效数字';
      if (b.type === 'int' && !Number.isInteger(n)) return '必须是整数';
      if (b.min != null && n < b.min) return `小于下限 ${b.min}`;
      if (b.max != null && n > b.max) return `大于上限 ${b.max}`;
      return null;
    }
    case 'enum': return (b.options ?? []).includes(v) ? null : '不在可选项中';
    case 'bool': return typeof v === 'boolean' ? null : '必须是开/关';
    case 'string': return typeof v === 'string' ? null : '必须是文本';
    default: return `类型 ${b.type} 不支持批量变化`;
  }
}
const coerce = (v, b) => (b.type === 'int' || b.type === 'float') ? Number(v) : v;
module.exports = {planBatch, checkValue, DEFAULT_MAX};
