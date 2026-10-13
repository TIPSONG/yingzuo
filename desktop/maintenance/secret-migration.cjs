'use strict';
// C01：内部已保存图的敏感值迁移/检查。只处理本应用数据根内的文件（草稿、关闭归档、模板版本），不改用户外部 JSON。
// 系统加密存储可用：把明文转为凭据引用（模板版本写新内容文件并更新该版本引用，旧明文文件无其他引用时删除）；
// 不可用：只记录位置（不含值），由调用方决定是否阻止（应用备份会阻止，避免把明文复制进新备份）。
// 结果写入 migrations/secret-scan.json。
const fs = require('node:fs');
const path = require('node:path');

function migrateStoredGraphs({db, layout, repo, policy, credentials, persistDrafts = null, now = () => new Date().toISOString()}) {
  const canSecure = !!credentials?.available?.();
  const report = {at: now(), canSecure, migrated: [], pending: []};
  const note = (kind, id, fields, done) => (done ? report.migrated : report.pending).push({kind, id, fields: fields.map(f => `${f.type}#${f.nodeId}.${f.field ?? f.name}`)});
  // 关闭归档
  const closed = layout.closed ?? path.join(layout.root, 'closed-workflows');
  if (fs.existsSync(closed)) for (const n of fs.readdirSync(closed).filter(n => /^[\w-]+\.json$/.test(n) && !n.endsWith('.meta.json'))) {
    const f = path.join(closed, n); let g; try { g = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const hits = policy.scan(g); if (!hits.length) continue;
    if (canSecure) { const tmp = `${f}.tmp`; fs.writeFileSync(tmp, JSON.stringify(policy.secureForStorage(g), null, 2)); fs.renameSync(tmp, f); }
    note('closed', n.slice(0, -5), hits, canSecure);
  }
  // 草稿：由编辑器按当前内存重写（磁盘副本经政策）
  const drafts = path.join(layout.root, 'drafts');
  if (fs.existsSync(drafts)) for (const n of fs.readdirSync(drafts).filter(n => n.endsWith('.json'))) {
    let g; try { g = JSON.parse(fs.readFileSync(path.join(drafts, n), 'utf8')); } catch { continue; }
    const hits = policy.scan(g); if (!hits.length) continue;
    let done = false; if (canSecure && persistDrafts) { try { persistDrafts(); done = !policy.scan(JSON.parse(fs.readFileSync(path.join(drafts, n), 'utf8'))).length; } catch { done = false; } }
    note('draft', n.slice(0, -5), hits, done);
  }
  // 模板版本（内容寻址）：写新文件、更新引用
  if (db && repo) {
    let rows = []; try { rows = db.all('SELECT version_id, graph_ref, graph_hash FROM template_versions'); } catch { rows = []; }
    for (const r of rows) {
      let g; try { g = repo._read(r.graph_ref, r.graph_hash); } catch { continue; }
      const hits = policy.scan(g); if (!hits.length) continue;
      if (canSecure) {
        const b = repo._blob('graphs', policy.secureForStorage(g));
        db.run('UPDATE template_versions SET graph_ref = ?, graph_hash = ? WHERE version_id = ?', b.ref, b.hash, r.version_id);
        if (!db.get('SELECT 1 AS x FROM template_versions WHERE graph_ref = ?', r.graph_ref)) fs.rmSync(path.join(repo.dir, ...r.graph_ref.split('/')), {force: true});
      }
      note('template-version', r.version_id, hits, canSecure);
    }
  }
  try { const dir = layout.migrations ?? path.join(layout.root, 'migrations'); fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(path.join(dir, 'secret-scan.json'), JSON.stringify(report, null, 2)); } catch { /* 记录失败不影响 */ }
  return report;
}
module.exports = {migrateStoredGraphs};
