'use strict';
// 退出租约从首次检查起一直保持到队列停止；只释放本次取得的租约。
async function prepareQuit({hooks, showMessageBox, cancelTimeoutMs = 15000, startingTimeoutMs = 5000}) {
  const releasePause = hooks.pauseSubmissions('quit');
  let released = false;
  const release = () => { if (!released) { released = true; releasePause?.(); } };
  const result = (decision, forced = false) => {
    if (decision === 'return') release();
    return {decision, forced, release};
  };
  try {
    let active = hooks.activeTasks();
    if (!active.length) {
      // starting 发生在 active 状态之前：后端队列查询/GPU 锁等待期间也不能直接退出。
      try { await hooks.waitForIdle({timeoutMs: startingTimeoutMs}); return result('quit'); }
      catch (error) { if (error?.code !== 'TIMEOUT') throw error; }
      active = hooks.activeTasks();
    }
    let cancel = false;
    if (active.length) {
      const choice = await showMessageBox({type: 'question', title: '任务正在运行', message: `还有 ${active.length} 个本应用任务在提交或运行。`, detail: '退出不会把任务标记为完成。可以等待完成后退出、取消后退出，或返回继续。', buttons: ['等待完成后退出', '取消任务后退出', '返回'], defaultId: 0, cancelId: 2});
      if (choice.response === 2) return result('return');
      cancel = choice.response === 1;
    }
    for (;;) {
      try {
        if (cancel) await hooks.cancelActive({timeoutMs: cancelTimeoutMs});
        else await hooks.waitForIdle({timeoutMs: cancelTimeoutMs});
        return result('quit');
      } catch (error) {
        if (error?.code !== 'TIMEOUT') throw error;
        const left = hooks.activeTasks().length;
        const next = await showMessageBox({type: 'warning', title: '任务尚未结束', message: left ? `仍有 ${left} 个任务未确认结束。` : '仍有任务处于启动或后端核对中，尚未确认结束。', detail: '仍然退出只会关闭映作，绘图和 LM Studio 服务保持运行；任务不会被标记为完成或已取消，下次启动会核对真实状态。环境维护尚未结束时仍不能退出。', buttons: ['继续等待', '仍然退出', '返回'], defaultId: 0, cancelId: 2});
        if (next.response === 1) return result('quit', true);
        if (next.response === 2) return result('return');
      }
    }
  } catch (error) { release(); throw error; }
}

/** 主进程退出顺序的唯一入口，供实际 main 和回归使用。finalize 必须在环境锁内停止队列后才销毁窗口。 */
async function runQuit({api, setQuitting, save, finalize, onError}) {
  let prepared = null, phase = 'prepare';
  try {
    prepared = await api.prepareQuit();
    if (prepared.decision === 'return') return false;
    setQuitting(true);
    phase = 'save';
    await save();
    phase = 'shutdown';
    await api.shutdownOwnedServices({force: prepared.forced, finalize});
    return true;
  } catch (error) {
    setQuitting(false);
    await onError(error, phase);
    return false;
  } finally { prepared?.release(); }
}
module.exports = {prepareQuit, runQuit};
