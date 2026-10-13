'use strict';
// T01–T04：templates.* 接口。
const fs = require('node:fs');
const path = require('node:path');
const {AppError, CODES} = require('../core/errors.cjs');
const {TemplateRepository} = require('../repositories/template-repo.cjs');
const ImportPipeline = require('../../shared/import-pipeline.cjs');
const F = require('../../shared/form-schema.cjs');
const B = require('../../shared/bindings.cjs');
const SF = require('../../shared/secret-fields.cjs');

function createTemplateService({db, layout, editor, taskService, dialog, getWindow, builtins = () => []}) {
  const repo = new TemplateRepository(db, layout.templates);
  const tabGraph = tabId => editor.enqueue(() => editor.commands.tabGraph(tabId));
  // S05：存为模板前把敏感输入（如 API Key）转入系统加密存储，图中只保留占位；导出时占位清空、不导出凭据
  const securedGraph = async tabId => { const t = await tabGraph(tabId); if (!taskService?.secrets) return t; const c = await compile(tabId); return {...t, graph: taskService.secrets.redactGraph(t.graph, c.apiPrompt)}; };
  const stripPlaceholders = v => (typeof v === 'string' ? (v.startsWith(SF.PLACEHOLDER_PREFIX) ? '' : v) : Array.isArray(v) ? v.map(stripPlaceholders) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripPlaceholders(x)])) : v);
  const compile = async tabId => { if (!taskService) throw new AppError(CODES.SERVICE_UNAVAILABLE, '任务服务不可用，无法编译工作流。'); return taskService.compile(tabId); };
  function importText(text, {name, folder, tags, source}) {
    let info;
    try { info = ImportPipeline.analyze(text, {name}); } catch (e) { throw new AppError(CODES.INVALID_ARGUMENT, e.message); }
    if (info.format !== 'ui') throw new AppError(CODES.INVALID_ARGUMENT, 'API 格式没有界面信息，不能直接存为模板。请先在创作页导入（会用官方 loadApiJson 重建），再“存为模板”。');
    return repo.create({name: info.name, graph: info.graph, folder, tags, source});
  }
  const methods = {
    'templates.list': async (filter = {}) => ({templates: repo.list(filter), folders: repo.folders()}),
    'templates.get': async id => { const t = repo.get(id); if (!t) throw new AppError(CODES.NOT_FOUND, '模板不存在。'); return {...t, versions: repo.versions(id)}; },
    'templates.update': async (id, patch) => repo.update(id, patch),
    'templates.import': async ({folder = '', tags = []} = {}) => {
      const r = await dialog.showOpenDialog(getWindow(), {title: '导入模板', properties: ['openFile', 'multiSelections'], filters: [{name: 'ComfyUI 工作流', extensions: ['json']}]});
      if (r.canceled || !r.filePaths?.length) return {cancelled: true};
      const imported = [], failed = [];
      for (const file of r.filePaths.slice(0, 50)) {
        try { imported.push(importText(fs.readFileSync(file, 'utf8'), {name: path.basename(file), folder, tags, source: `file:${path.basename(file)}`})); }
        catch (e) { failed.push({file: path.basename(file), error: e.message}); }
      }
      return {imported, failed};
    },
    /** 内置五个模板：从 ComfyUI workflows 目录只读导入一次（来源文件不修改）。 */
    'templates.importBuiltins': async () => {
      const out = [];
      for (const b of builtins()) {
        const source = `builtin:${b.id}`;
        if (repo.findBySource(source)) { out.push({id: b.id, status: 'exists'}); continue; }
        if (!b.path || !fs.existsSync(b.path)) { out.push({id: b.id, status: 'missing', path: b.path}); continue; }
        try { importText(fs.readFileSync(b.path, 'utf8'), {name: b.name, folder: '内置', tags: [b.id.startsWith('gemma') || b.id === 'prompt' ? 'Gemma 润色' : b.id === 'edit' ? '图像编辑' : '文生图'], source}); out.push({id: b.id, status: 'imported'}); }
        catch (e) { out.push({id: b.id, status: 'failed', error: e.message}); }
      }
      return out;
    },
    'templates.open': async (id, versionId) => {
      const v = versionId ? repo.version(versionId) : repo.current(id);
      if (v.templateId !== id) throw new AppError(CODES.INVALID_ARGUMENT, '版本不属于该模板。');
      return editor.enqueue(() => editor.commands.openGraph(repo.get(id).name, v.graph, id));
    },
    /** T02：把当前标签存为模板新版本；标签不是从模板打开的则新建模板。 */
    'templates.saveFromTab': async (tabId, {name, note, asNew = false, formSchema} = {}) => {
      const t = await securedGraph(tabId);
      if (t.templateId && repo.get(t.templateId) && !asNew) return {template: repo.get(t.templateId), version: repo.saveVersion(t.templateId, {graph: t.graph, formSchema: formSchema ?? repo.current(t.templateId).formSchema, note: note ?? '从工作副本保存'})};
      const created = t.templateId && repo.get(t.templateId) ? repo.saveAs(t.templateId, {name: name ?? `${t.title} 副本`, graph: t.graph, formSchema}) : repo.create({name: name ?? t.title, graph: t.graph, formSchema, source: 'workspace'});
      return {template: created, version: repo.versions(created.id)[0]};
    },
    'templates.restore': async (id, versionId) => repo.restore(id, versionId),
    'templates.export': async (id, versionId) => {
      const v = versionId ? repo.version(versionId) : repo.current(id);
      const r = await dialog.showSaveDialog(getWindow(), {title: '导出模板', defaultPath: `${repo.get(id).name}.json`, filters: [{name: 'ComfyUI 工作流', extensions: ['json']}]});
      if (r.canceled || !r.filePath) return {cancelled: true};
      fs.writeFileSync(r.filePath, JSON.stringify(stripPlaceholders(v.graph), null, 2));
      if (v.formSchema) fs.writeFileSync(r.filePath.replace(/\.json$/i, '') + '.yingzuo-form.json', JSON.stringify({kind: 'yingzuo-form', version: 1, fields: v.formSchema}, null, 2));
      return {path: r.filePath};
    },
    /** T03：表单编辑。默认表单由当前编译结果推断；保存时与图一起成为新版本。 */
    'templates.formDraft': async (id, tabId) => {
      const c = await compile(tabId);
      const saved = id ? repo.current(id).formSchema : null;
      const fields = saved ?? F.fromBindings(c.bindings);
      // 可选字段：所有未连线的标量输入（供用户添加）
      const available = Object.entries(c.apiPrompt).flatMap(([nodeId, n]) => Object.entries(n.inputs ?? {}).filter(([, v]) => !B.isLink(v) && ['string', 'number', 'boolean'].includes(typeof v)).map(([fieldName, v]) => ({nodeId, nodeType: n.class_type, fieldName, value: v})));
      return {fields, mapping: F.validateMapping(fields, c.apiPrompt), available, fromSaved: !!saved};
    },
    'templates.saveForm': async (id, tabId, fields, note) => {
      const errors = F.validateSchema(fields);
      if (errors.length) throw new AppError(CODES.INVALID_ARGUMENT, errors[0], {details: {errors}});
      const c = await compile(tabId);
      const bad = F.validateMapping(fields, c.apiPrompt).filter(m => m.status !== 'ok');
      if (bad.length) throw new AppError(CODES.INVALID_ARGUMENT, `有 ${bad.length} 个字段映射失效：${bad[0].reason}`, {details: {bad}});
      const t = await securedGraph(tabId);
      return repo.saveVersion(id, {graph: t.graph, formSchema: fields, note: note ?? '更新表单'});
    },
    /** T04：映射校验与重新绑定（必须同类型同字段）。 */
    'templates.checkMapping': async (id, tabId) => { const c = await compile(tabId); const fields = repo.current(id).formSchema ?? []; return F.validateMapping(fields, c.apiPrompt); },
    'templates.rebind': async (id, tabId, index, nodeId) => {
      const c = await compile(tabId); const cur = repo.current(id); const fields = [...(cur.formSchema ?? [])];
      if (!fields[index]) throw new AppError(CODES.NOT_FOUND, '字段不存在。');
      try { fields[index] = F.rebind(fields[index], c.apiPrompt, nodeId); } catch (e) { throw new AppError(CODES.INVALID_ARGUMENT, e.message); }
      const t = await securedGraph(tabId);
      return repo.saveVersion(id, {graph: t.graph, formSchema: fields, note: `重新绑定 ${fields[index].label ?? fields[index].fieldName} → 节点 ${nodeId}`});
    },
  };
  return {repo, methods};
}
module.exports = {createTemplateService};
