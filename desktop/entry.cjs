'use strict';
// 应用入口：`--yz-smoke=<结果文件>` 时只做打包自检（B03，不触碰用户数据），否则启动正式主进程。
// R21：单实例锁先于数据迁移和业务初始化；第二个实例不写工作区、不启动恢复，只通知已有窗口后退出。
const path = require('node:path');
const {smokeTarget, runSmoke} = require('./smoke.cjs');
const target = smokeTarget(process.argv);
if (target) {
  const {app} = require('electron');
  app.whenReady().then(() => runSmoke(target, {app})).then(ok => app.exit(ok ? 0 : 1), () => app.exit(1));
} else {
  const {app} = require('electron');
  // 与 main.cjs 一致的开发期 userData（锁按 userData 计算）
  if (!app.isPackaged) app.setPath('userData', path.join(path.resolve(__dirname, '..'), '.local', 'electron-profile'));
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    // R13：已登记的应用数据恢复在打开数据库之前执行（没有登记时同步继续）
    const fs = require('node:fs');
    const {resolveDataRoot, ensureLayout} = require('./repositories/data-root.cjs');
    let pending = null;
    try {
      const dr = resolveDataRoot({isPackaged: !!app.isPackaged, exePath: app.isPackaged ? process.execPath : null, userData: app.isPackaged ? app.getPath('userData') : null, devRoot: path.resolve(__dirname, '..')});
      if (fs.existsSync(path.join(dr.root, 'pending-app-restore.json'))) pending = ensureLayout(dr.root);
    } catch { /* 数据根问题由 main.cjs 正常报告 */ }
    // C04：先决定 normal / recovery。恢复失败、标记损坏或未完成时进入独立恢复模式，不加载 main（不打开/迁移数据库、不组装写服务）
    if (!pending) require('./main.cjs');
    else require('./maintenance/app-backup.cjs').applyPendingAppRestore(pending)
      .then(r => r, e => ({status: 'failed', recovery: true, error: e.message}))
      .then(r => { globalThis.__yzAppRestore = r; if (r?.recovery) require('./recovery.cjs').startRecovery({layout: pending, result: r}); else require('./main.cjs'); });
  }
}
