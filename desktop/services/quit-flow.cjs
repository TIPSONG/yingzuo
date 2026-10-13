'use strict';
// S07/D09：退出前处理本应用运行中任务。取消/等待超时不当作成功，由用户决定。
async function prepareQuit({hooks, showMessageBox, cancelTimeoutMs = 15000}) {
  const active = hooks.activeTasks();
  if (!active.length) return 'quit';
  const choice = await showMessageBox({type: 'question', title: '任务正在运行', message: `还有 ${active.length} 个本应用任务在提交或运行。`, detail: '退出不会把任务标记为完成。可以等待完成后退出、取消后退出，或返回继续。', buttons: ['等待完成后退出', '取消任务后退出', '返回'], defaultId: 0, cancelId: 2});
  if (choice.response === 2) return 'return';
  hooks.pauseSubmissions('quit');
  // D09：取消/等待未在时限内结束时不当作成功；让用户决定
  for (;;) {
    try {
      if (choice.response === 1) await hooks.cancelActive({timeoutMs: cancelTimeoutMs});
      else await hooks.waitForIdle();
      return 'quit';
    } catch (error) {
      if (error?.code !== 'TIMEOUT') { hooks.resumeSubmissions('quit'); throw error; }
      const left = hooks.activeTasks().length;
      const next = await showMessageBox({type: 'warning', title: '任务尚未结束', message: `取消请求已发出，但仍有 ${left} 个任务未确认结束。`, detail: '强制退出时，这些任务不会被标记为完成或已取消；下次启动会向 ComfyUI 核对真实状态。', buttons: ['继续等待', '仍然退出', '返回'], defaultId: 0, cancelId: 2});
      if (next.response === 1) return 'quit';
      if (next.response === 2) { hooks.resumeSubmissions('quit'); return 'return'; }
    }
  }
}
module.exports = {prepareQuit};
