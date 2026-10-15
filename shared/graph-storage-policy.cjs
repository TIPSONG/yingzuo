'use strict';
// C01：UI 图统一的保存 / 导出边界（纯函数 + 小工厂）。所有草稿、关闭归档、模板创建/版本、普通 JSON 导出、图包导出、
// 修复副本导出与应用备份前的内部文件都经过这里，不依赖“用户先运行一次”。
// 识别敏感 widget 的依据（任一命中即敏感）：
//   1) object_info 声明 password/sensitive，或字段名匹配（api_key/token/secret/password），按 widget 顺序映射到 widgets_values；
//   2) 节点 inputs[].widget.name 给出的字段名（已转为输入的 widget）；
//   3) 对象形式的 widgets_values 的键名；
//   4) 已保存在系统加密存储中的节点凭据明文（任何位置出现都替换）；
//   5) 明显的密钥格式（sk-…、hf_…、ghp_…、AIza…、xox?-…）。
// 内部保存：真实值转入系统加密存储（node-secret:<hash>），图中只留占位；存储不可用时抛 CREDENTIAL_UNAVAILABLE（调用方保留内存修改）。
// 对外导出：真实值与本机凭据标识都移除，返回需重新填写的字段清单；普通提示词、结构与模型选择保持不变。
// 载入：占位在内存中还原为真实值；缺凭据时保留占位并报告 missing。
const crypto = require('node:crypto');
const SF = require('./secret-fields.cjs');

const KEY_LIKE = /^(sk-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[abpr]-[A-Za-z0-9-]{10,})$/;
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
// RV02：forceInput / rawLink 的输入只能连线，不占 widgets_values 位置。
const isWidgetDef = def => Array.isArray(def) && (Array.isArray(def[0]) || WIDGET_TYPES.has(def[0])) && !def[1]?.forceInput && !def[1]?.rawLink;

/** 按 object_info 推出 widgets_values 每一位对应的字段名（seed 类之后的 control_after_generate 占一位）。 */
function widgetNames(classType, objectInfo) {
  const info = objectInfo?.[classType]?.input; if (!info) return null;
  const out = [];
  for (const group of [info.required ?? {}, info.optional ?? {}]) for (const [name, def] of Object.entries(group)) {
    if (!isWidgetDef(def)) continue;
    out.push({name, def});
    if (def[0] === 'INT' && (def[1]?.control_after_generate || /^(noise_)?seed$/.test(name))) out.push({name: `${name}::control`, def: null});
  }
  return out;
}
/** 遍历根图与嵌套子图定义中的节点。 */
function* nodesOf(graph) {
  for (const n of graph?.nodes ?? []) yield {scope: 'root', node: n};
  for (const sg of graph?.definitions?.subgraphs ?? []) for (const n of sg?.nodes ?? []) yield {scope: `subgraph:${sg.id}`, node: n};
}
/** 找出图中的敏感 widget：[{scope,nodeId,type,key,name,value}]（key 是 widgets_values 的下标或键）。 */
function findSecretWidgets(graph, {objectInfo = null, knownValues = new Set(), uncertain = []} = {}) {
  const hits = [];
  for (const {scope, node} of nodesOf(graph)) {
    const wv = node?.widgets_values; if (!wv || typeof wv !== 'object') continue;
    const type = String(node.type ?? '');
    const add = (key, name) => { const value = wv[key]; if (typeof value === 'string' && value) hits.push({scope, nodeId: String(node.id), type, key, name, value}); };
    if (!Array.isArray(wv)) { for (const k of Object.keys(wv)) if (SF.isSecretInput(type, k, SF.defOf(objectInfo, type, k)) || knownValues.has(wv[k]) || KEY_LIKE.test(String(wv[k] ?? ''))) add(k, k); continue; }
    let names = widgetNames(type, objectInfo);
    const marked = new Set();
    // RV02：只有推出的 widget 位数与实际 widgets_values 长度一致时才按位置映射；不一致（自定义序列化、
    // 动态输入等）视为对应关系未知，不按猜测的位置处理，转为按值识别并报告 uncertain。
    const declaredSecret = names ? names.find(w => w.def && SF.isSecretInput(type, w.name, w.def))?.name : null;
    if (names && names.length !== wv.length) names = null;
    if (names) names.forEach((w, i) => { if (w.def && i < wv.length && SF.isSecretInput(type, w.name, w.def)) { add(i, w.name); marked.add(i); } });
    // 没有可靠映射：已转为输入的 widget 名称 / object_info 声明的敏感字段 + 已知明文 + 密钥格式
    const widgetInputs = (node.inputs ?? []).filter(x => x?.widget?.name).map(x => x.widget.name);
    const secretField = declaredSecret ?? widgetInputs.find(n => SF.isSecretInput(type, n, null));
    if (!names && secretField) {
      // 位置未知不能靠长度猜密码，也不能把模型名登记成凭据。
      uncertain.push({scope, nodeId: String(node.id), type, field: secretField, unresolved: true});
    }
    wv.forEach((v, i) => { if (!marked.has(i) && typeof v === 'string' && v && !SF.isPlaceholder(v) && (knownValues.has(v) || KEY_LIKE.test(v))) { add(i, names?.[i]?.name ?? `#${i}`); marked.add(i); } });
  }
  return hits;
}
const secretName = value => `node-secret:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
function setAt(graph, hit, v) {
  for (const {scope, node} of nodesOf(graph)) if (scope === hit.scope && String(node.id) === hit.nodeId) node.widgets_values[hit.key] = v;
}
/**
 * 工厂：credentials 是 CredentialStore（available/get/set/read）；objectInfo() 返回缓存的 object_info 或 null。
 */
function createGraphStoragePolicy({credentials, objectInfo = () => null} = {}) {
  /** 已保存的节点凭据明文（用于在任意位置识别）。 */
  function knownValues() {
    const out = new Set();
    try { if (!credentials?.available?.()) return out; for (const [name, item] of Object.entries(credentials.read().items ?? {})) if (name.startsWith('node-secret:') && item.confirmedNodeSecret === true) { const v = credentials.get(name); if (v) out.add(v); } } catch { /* 读取失败时只用其他依据 */ }
    return out;
  }
  /** 内部保存：返回磁盘副本（不改原对象）。 */
  function secureForStorage(graph) { return secureWithValues(graph).graph; }
  /** RV03：同 secureForStorage，另返回 明文→凭据名 映射，供任务快照的其他字段（表单值、参数等）一并替换。 */
  function secureWithValues(graph) {
    const values = new Map();
    if (!graph || typeof graph !== 'object') return {graph, values};
    const known = knownValues();
    const uncertain = [];
    const hits = findSecretWidgets(graph, {objectInfo: objectInfo(), knownValues: known, uncertain}).filter(h => !SF.isPlaceholder(h.value));
    assertSafeExport({uncertain});
    if (!hits.length) return {graph, values};
    if (!credentials?.available?.()) throw Object.assign(new Error('图中含敏感输入（如 API Key），但系统加密存储不可用；为避免明文写入磁盘，未保存。修改仍保留在当前窗口。'), {code: 'CREDENTIAL_UNAVAILABLE', fields: hits.map(({value, ...h}) => h)});
    const out = structuredClone(graph);
    const items = credentials.read?.()?.items ?? {};
    for (const h of hits) { const name = secretName(h.value); if (!items[name]?.confirmedNodeSecret) { credentials.set(name, h.value, {confirmedNodeSecret: true}); items[name] = {confirmedNodeSecret: true}; } setAt(out, h, SF.PLACEHOLDER_PREFIX + name); values.set(h.value, name); }
    return {graph: out, values};
  }
  /** 对外导出：移除真实值与本机凭据标识，返回 {graph, refill}。 */
  function stripForExport(graph) {
    const out = structuredClone(graph);
    // 旧版可能把普通模型名保存成未标来源的凭据；只有明确的非敏感字段才还原它。
    const info = objectInfo();
    for (const {node} of nodesOf(out)) {
      const wv = node.widgets_values; if (!wv || typeof wv !== 'object') continue;
      const names = Array.isArray(wv) ? widgetNames(node.type, info) : null;
      for (const [key, value] of Object.entries(wv)) {
        if (!SF.isPlaceholder(value)) continue;
        const name = value.slice(SF.PLACEHOLDER_PREFIX.length);
        const item = credentials?.read?.().items?.[name];
        if (item?.confirmedNodeSecret) continue;
        const field = Array.isArray(wv) ? (names?.length === wv.length ? names[Number(key)] : null) : {name: key, def: SF.defOf(info, node.type, key)};
        if (field && SF.isSecretInput(node.type, field.name, field.def)) continue;
        // 旧记录既可能是误收的模型名，也可能是仅由 password:true 标记的真密钥。
        // 单有对象键名不足以证明它不敏感；没有节点定义就不能解密后公开。
        if (!field?.def) assertSafeExport({uncertain: [{nodeId: String(node.id), type: node.type, field: field?.name ?? 'widgets_values'}]});
        let restored; try { restored = credentials?.get?.(name); } catch { /* 明确报错而非清空普通字段 */ }
        if (typeof restored !== 'string') throw Object.assign(new Error(`节点 ${node.id} 的旧凭据无法还原，请连接节点定义并重新填写后导出。`), {code: 'CREDENTIAL_UNAVAILABLE'});
        wv[key] = restored;
      }
    }
    const uncertain = [];
    const hits = findSecretWidgets(out, {objectInfo: info, knownValues: knownValues(), uncertain});
    assertSafeExport({uncertain});
    const refill = [];
    // 只有明确的字段/凭据证据才清空；位置不明的输入在写盘前阻止整个导出。
    for (const h of hits) {
      setAt(out, h, ''); refill.push({scope: h.scope, nodeId: h.nodeId, type: h.type, field: h.name});
    }
    // 其余位置残留的占位（本机凭据标识）也清空
    const walk = v => (typeof v === 'string' ? (SF.isPlaceholder(v) ? '' : v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
    const seen = new Set();
    return {graph: walk(out), refill, uncertain: uncertain.filter(u => { const k = `${u.scope}|${u.nodeId}|${u.field}|${u.key ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; })};
  }
  /** 载入：在内存中把占位还原；缺凭据保留占位并列出。 */
  function resolveInMemory(graph) {
    const missing = [];
    const walk = v => {
      if (typeof v === 'string' && SF.isPlaceholder(v)) { const name = v.slice(SF.PLACEHOLDER_PREFIX.length); let s = null; try { s = credentials?.get?.(name) ?? null; } catch { s = null; } if (s) return s; missing.push(name); return v; }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return {graph: walk(graph), missing};
  }
  /** 检查（迁移记录用）：返回仍含明文敏感值的位置，不含值本身。 */
  function scan(graph) { const uncertain = []; const hits = findSecretWidgets(graph, {objectInfo: objectInfo(), knownValues: knownValues(), uncertain}).filter(h => !SF.isPlaceholder(h.value)).map(({value, ...h}) => h); return [...hits, ...uncertain]; }
  return {secureForStorage, secureWithValues, stripForExport, resolveInMemory, scan, knownValues, getObjectInfo: objectInfo};
}
function assertSafeExport(result) {
  if (result?.uncertain?.length) throw Object.assign(new Error(`无法确认敏感字段位置，已阻止保存或导出；请连接 ComfyUI 并校正节点输入：${result.uncertain.map(u => `${u.type}#${u.nodeId}.${u.field}`).join('、')}`), {code: 'INVALID_STATE', details: {uncertain: result.uncertain}});
  return result;
}
module.exports = {createGraphStoragePolicy, findSecretWidgets, widgetNames, secretName, KEY_LIKE, assertSafeExport};
