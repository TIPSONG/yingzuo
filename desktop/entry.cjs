'use strict';
// 应用入口：`--yz-smoke=<结果文件>` 时只做打包自检（B03，不触碰用户数据），否则启动正式主进程。
const {smokeTarget, runSmoke} = require('./smoke.cjs');
const target = smokeTarget(process.argv);
if (target) {
  const {app} = require('electron');
  app.whenReady().then(() => runSmoke(target, {app})).then(ok => app.exit(ok ? 0 : 1), () => app.exit(1));
} else {
  require('./main.cjs');
}
