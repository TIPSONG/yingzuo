'use strict';
// C04：独立的应用数据恢复模式。应用数据恢复失败、恢复标记损坏或仍有未完成 journal 时，entry 加载本模块而不是 main.cjs：
// 只读取恢复记录、显示错误、提供“继续恢复 / 回退 / 退出 / 打开日志目录”；不打开或迁移业务数据库、不组装普通写服务、
// 不自动保存、不恢复下载或更新任务。用户选择后写同一个恢复标记并重启，由下次启动在打开数据库之前执行。
const fs = require('node:fs');
const path = require('node:path');
const appBackup = require('./maintenance/app-backup.cjs');

function readJournal(layout, id) {
  if (!id) return null;
  try { const j = JSON.parse(fs.readFileSync(path.join(layout.migrations, 'app-restore', `${id}.json`), 'utf8')); return {id: j.id, status: j.status, lastError: j.lastError ?? null, items: j.items.map(i => ({id: i.id, type: i.type, steps: i.steps}))}; } catch { return null; }
}
/** 纯处理函数（便于测试）：不触碰数据库。 */
function createRecoveryHandlers({layout, result, app, shell}) {
  return {
    state: () => ({status: result?.status ?? 'failed', error: result?.error ?? null, dir: result?.dir ?? null, journal: readJournal(layout, result?.journalId ?? appBackup.appRecoveryState(layout)?.journalId), pending: appBackup.appRecoveryState(layout), logs: layout.logs ?? layout.root}),
    choose: action => { const r = appBackup.chooseAppRecovery(layout, action); app.relaunch(); app.exit(0); return r; },
    quit: () => { app.exit(0); return {quit: true}; },
    openLogs: () => shell.openPath(layout.logs ?? layout.root),
  };
}
const OPS = new Set(['state', 'choose', 'quit', 'openLogs']);
function startRecovery({layout, result}) {
  const {app, BrowserWindow, ipcMain, shell} = require('electron');
  const h = createRecoveryHandlers({layout, result, app, shell});
  ipcMain.handle('yz-recovery', async (_e, {op, arg} = {}) => { if (!OPS.has(op)) throw new Error('未知操作'); return h[op](arg); });
  const open = () => {
    const w = new BrowserWindow({width: 720, height: 560, title: '映作 — 应用数据恢复', webPreferences: {preload: path.join(__dirname, 'recovery-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false}});
    w.loadFile(path.join(__dirname, 'recovery.html'));
  };
  app.whenReady().then(open);
  app.on('window-all-closed', () => app.exit(0));
  return h;
}
module.exports = {createRecoveryHandlers, startRecovery, readJournal};
