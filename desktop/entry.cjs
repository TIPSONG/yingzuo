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
  else require('./main.cjs');
}
