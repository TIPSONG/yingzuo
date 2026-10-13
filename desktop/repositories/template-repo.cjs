'use strict';
// T01/T02：模板仓库。模板与工作副本使用不同 ID 与存储；每个版本保存完整 UI 图与表单 schema（内容寻址文件），
// 版本只追加：保存、恢复旧版都生成新版本；原始来源文件只读，从不覆盖。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {AppError, CODES} = require('../core/errors.cjs');
const {writeFileAtomic} = require('../core/fs-atomic.cjs');
const {validateSchema} = require('../../shared/form-schema.cjs');

const hashOf = text => crypto.createHash('sha256').update(text).digest('hex');
const cleanName = (s, max = 80) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const cleanTags = tags => [...new Set((Array.isArray(tags) ? tags : []).map(t => cleanName(t, 30)).filter(Boolean))].slice(0, 20);
const cleanFolder = f => cleanName(f, 120).split('/').map(s => s.trim()).filter(s => s && s !== '.' && s !== '..').join('/');

class TemplateRepository {
  constructor(db, dir, {now = () => new Date().toISOString()} = {}) { this.db = db; this.dir = dir; this.now = now; fs.mkdirSync(dir, {recursive: true}); }
  _blob(kind, value) {
    const text = JSON.stringify(value);
    const hash = hashOf(text);
    const rel = `${kind}/${hash.slice(0, 2)}/${hash}.json`;
    const file = path.join(this.dir, ...rel.split('/'));
    if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), {recursive: true}); writeFileAtomic(file, text); }
    return {ref: rel, hash};
  }
  _read(ref, hash) {
    if (!/^(graphs|forms)\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/.test(ref)) throw new AppError(CODES.CORRUPT_DATA, '模板文件引用无效。');
    const text = fs.readFileSync(path.join(this.dir, ...ref.split('/')), 'utf8');
    if (hash && hashOf(text) !== hash) throw new AppError(CODES.CORRUPT_DATA, '模板版本文件校验失败（内容被修改）。');
    return JSON.parse(text);
  }
  _row(r) { return r && {id: r.id, name: r.name, folder: r.folder, tags: JSON.parse(r.tags), favorite: !!r.favorite, currentVersion: r.current_version, source: r.source, thumbnail: r.thumbnail, license: r.license, author: r.author, createdAt: r.created_at, updatedAt: r.updated_at}; }
  create({name, graph, formSchema = null, folder = '', tags = [], source, license = null, author = null, note = '导入'}) {
    if (!graph || !Array.isArray(graph.nodes)) throw new AppError(CODES.INVALID_ARGUMENT, '模板必须是 ComfyUI UI 格式工作流（含 nodes）。');
    const id = `tpl_${crypto.randomUUID()}`, at = this.now();
    this.db.transaction(() => {
      this.db.run('INSERT INTO templates (id, name, folder, tags, favorite, current_version, source, license, author, created_at, updated_at) VALUES (?,?,?,?,0,NULL,?,?,?,?,?)', id, cleanName(name) || '未命名模板', cleanFolder(folder), JSON.stringify(cleanTags(tags)), String(source ?? 'local'), license, author, at, at);
      this.saveVersion(id, {graph, formSchema, note, source: String(source ?? 'local')});
    });
    return this.get(id);
  }
  get(id) { return this._row(this.db.get('SELECT * FROM templates WHERE id = ?', id)); }
  list({search = '', folder = null, tag = null, favorite = false} = {}) {
    let rows = this.db.all('SELECT * FROM templates ORDER BY favorite DESC, updated_at DESC').map(r => this._row(r));
    const s = search.trim().toLowerCase();
    if (s) rows = rows.filter(r => r.name.toLowerCase().includes(s) || r.tags.some(t => t.toLowerCase().includes(s)) || r.folder.toLowerCase().includes(s));
    if (folder !== null) rows = rows.filter(r => r.folder === folder || r.folder.startsWith(`${folder}/`));
    if (tag) rows = rows.filter(r => r.tags.includes(tag));
    if (favorite) rows = rows.filter(r => r.favorite);
    return rows;
  }
  folders() { return [...new Set(this.db.all('SELECT folder FROM templates').map(r => r.folder).filter(Boolean))].sort(); }
  update(id, patch = {}) {
    const t = this.get(id); if (!t) throw new AppError(CODES.NOT_FOUND, '模板不存在。');
    const next = {name: patch.name !== undefined ? cleanName(patch.name) || t.name : t.name, folder: patch.folder !== undefined ? cleanFolder(patch.folder) : t.folder, tags: patch.tags !== undefined ? cleanTags(patch.tags) : t.tags, favorite: patch.favorite !== undefined ? !!patch.favorite : t.favorite};
    this.db.run('UPDATE templates SET name=?, folder=?, tags=?, favorite=?, updated_at=? WHERE id=?', next.name, next.folder, JSON.stringify(next.tags), next.favorite ? 1 : 0, this.now(), id);
    return this.get(id);
  }
  saveVersion(templateId, {graph, formSchema, note = null, source = 'edit', expectedCurrent} = {}) {
    const t = this.db.get('SELECT * FROM templates WHERE id = ?', templateId);
    if (!t) throw new AppError(CODES.NOT_FOUND, '模板不存在。');
    if (expectedCurrent !== undefined && expectedCurrent !== t.current_version) throw new AppError(CODES.CONFLICT, '模板已在别处更新，请刷新后再保存。');
    if (!graph || !Array.isArray(graph.nodes)) throw new AppError(CODES.INVALID_ARGUMENT, '版本必须包含 UI 图。');
    if (formSchema) { const errors = validateSchema(formSchema); if (errors.length) throw new AppError(CODES.INVALID_ARGUMENT, `表单 schema 无效：${errors[0]}`, {details: {errors}}); }
    const g = this._blob('graphs', this.secureGraph ? this.secureGraph(graph) : graph); // C01：模板图经统一保存政策
    const f = formSchema ? this._blob('forms', formSchema) : null;
    const versionId = `tv_${crypto.randomUUID()}`, at = this.now();
    this.db.transaction(() => {
      this.db.run('INSERT INTO template_versions (version_id, template_id, parent_id, graph_ref, graph_hash, form_schema_ref, source, note, saved_at) VALUES (?,?,?,?,?,?,?,?,?)', versionId, templateId, t.current_version, g.ref, g.hash, f ? `${f.ref}#${f.hash}` : null, source, note ? cleanName(note, 200) : null, at);
      this.db.run('UPDATE templates SET current_version=?, updated_at=? WHERE id=?', versionId, at, templateId);
    });
    return this.version(versionId);
  }
  versions(templateId) { return this.db.all('SELECT version_id, parent_id, graph_hash, form_schema_ref, source, note, saved_at FROM template_versions WHERE template_id = ? ORDER BY saved_at DESC, rowid DESC', templateId).map(r => ({versionId: r.version_id, parentId: r.parent_id, graphHash: r.graph_hash, hasForm: !!r.form_schema_ref, source: r.source, note: r.note, savedAt: r.saved_at})); }
  version(versionId) {
    const r = this.db.get('SELECT * FROM template_versions WHERE version_id = ?', versionId);
    if (!r) throw new AppError(CODES.NOT_FOUND, '模板版本不存在。');
    const [fref, fhash] = (r.form_schema_ref ?? '').split('#');
    return {versionId: r.version_id, templateId: r.template_id, parentId: r.parent_id, source: r.source, note: r.note, savedAt: r.saved_at, graph: this._read(r.graph_ref, r.graph_hash), formSchema: fref ? this._read(fref, fhash) : null};
  }
  current(templateId) { const t = this.get(templateId); if (!t) throw new AppError(CODES.NOT_FOUND, '模板不存在。'); return {template: t, ...this.version(t.currentVersion)}; }
  /** 恢复旧版：复制为新版本（历史不丢）。 */
  restore(templateId, versionId) {
    const v = this.version(versionId);
    if (v.templateId !== templateId) throw new AppError(CODES.INVALID_ARGUMENT, '版本不属于该模板。');
    return this.saveVersion(templateId, {graph: v.graph, formSchema: v.formSchema, note: `恢复自 ${v.savedAt}`, source: 'restore'});
  }
  /** 另存为新模板（新 ID，独立版本历史）。 */
  saveAs(templateId, {name, graph, formSchema}) {
    const t = this.get(templateId); if (!t) throw new AppError(CODES.NOT_FOUND, '模板不存在。');
    return this.create({name, graph, formSchema, folder: t.folder, tags: t.tags, source: `copy:${templateId}`, license: t.license, author: t.author, note: `另存自 ${t.name}`});
  }
  setThumbnail(templateId, buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 5 * 1024 * 1024 || buffer.readUInt32BE(0) !== 0x89504e47) throw new AppError(CODES.INVALID_ARGUMENT, '缩略图必须是 5 MB 以内的 PNG。');
    const rel = `thumbs/${hashOf(buffer)}.png`; const file = path.join(this.dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), {recursive: true}); if (!fs.existsSync(file)) writeFileAtomic(file, buffer);
    this.db.run('UPDATE templates SET thumbnail=?, updated_at=? WHERE id=?', rel, this.now(), templateId);
    return this.get(templateId);
  }
  /** 只删除模板记录到回收（版本文件保留，可由维护清理）。 */
  findBySource(source) { return this._row(this.db.get('SELECT * FROM templates WHERE source = ?', source)); }
}
module.exports = {TemplateRepository};
