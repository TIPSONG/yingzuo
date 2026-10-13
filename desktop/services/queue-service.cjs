'use strict';
// Q03–Q07、Q10：单一串行调度器。只允许一个本应用任务处于 submitting/submitted/running；
// FIFO；Gemma 阶段与绘图共用 GPU 锁；外部任务存在时等待；响应丢失时先核对 queue/history，
// 不能证明时置 unknown，绝不自动重发。完成以 history 终态为准。
const {AppError, CODES} = require('../core/errors.cjs');
const {CancelToken} = require('../core/locks.cjs');
const {parseQueue, parseHistoryEntry, nodeErrorList} = require('../adapters/comfy-http.cjs');
const ACTIVE = ['preparing', 'submitting', 'submitted', 'running', 'reconciling'];

class QueueService {
  /**
   * @param o.tasks TaskRepository  o.client() → ComfyHttpClient  o.gpuLock Mutex  o.events EventBus
   *   o.prepare(task, snapshot, client, token) → 返回实际提交的 API prompt（上传参考图等）
   *   o.onTerminal(task) 终态回调（作品关联）
   */
  constructor({tasks, client, gpuLock, events, logger, clientId, prepare = async (_t, s) => s.apiPrompt, onTerminal = () => {}, pollMs = 1500, externalWaitMs = 3000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now()}) {
    Object.assign(this, {tasks, client, gpuLock, events, logger, clientId, prepare, onTerminal, pollMs, externalWaitMs, sleep, now});
    this.paused = false; this.running = null; this.tokens = new Map(); this.external = new Map(); this.pumping = false; this.stopped = false; this.idleWaiters = []; this.leases = new Map(); this.leaseSeq = 0;
  }
  /* ---------- 入队 ---------- */
  enqueue({kind = 'generate', workflowId, snapshot, inputRevision, groupId = null}) {
    if (!snapshot?.apiPrompt || typeof snapshot.apiPrompt !== 'object' || !Object.keys(snapshot.apiPrompt).length) throw new AppError(CODES.INVALID_ARGUMENT, '空图不能运行：没有可提交的节点。');
    const task = this.tasks.create({kind, workflowId, snapshot, inputRevision, clientId: this.clientId, groupId});
    this.kick();
    return task;
  }
  /** R19：整组在同一数据库事务中登记；任一项失败整组不登记。 */
  enqueueGroup(specs) {
    for (const sp of specs) if (!sp.snapshot?.apiPrompt || !Object.keys(sp.snapshot.apiPrompt).length) throw new AppError(CODES.INVALID_ARGUMENT, '空图不能运行：没有可提交的节点。');
    const created = this.tasks.db.transaction(() => specs.map(({kind = 'generate', workflowId, snapshot, inputRevision, groupId = null}) => this.tasks.create({kind, workflowId, snapshot, inputRevision, clientId: this.clientId, groupId})));
    this.kick();
    return created;
  }
  activeTasks() { return this.tasks.list({states: ACTIVE, limit: 50}); }
  isIdle() { return !this.activeTasks().length && !this.tasks.nextQueued(); }
  /** 等待本应用任务全部结束；timeoutMs 到期抛 TIMEOUT（不当作空闲）。 */
  waitForIdle({timeoutMs} = {}) {
    if (!this.activeTasks().length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = () => { clearTimeout(timer); resolve(); };
      this.idleWaiters.push(done);
      if (timeoutMs) timer = setTimeout(() => { this.idleWaiters = this.idleWaiters.filter(w => w !== done); reject(new AppError(CODES.TIMEOUT, `等待任务结束超时（${Math.round(timeoutMs / 1000)} 秒）。`)); }, timeoutMs);
    });
  }
  /** PR11-R01：暂停租约。系统暂停（维护/退出）与用户暂停分开；释放租约不会把用户暂停的任务改回排队。 */
  acquirePause(reason) {
    const id = ++this.leaseSeq; this.leases.set(id, reason);
    this.events?.emit('queue.state', null, this.state());
    let released = false;
    const release = () => { if (released) return; released = true; this.leases.delete(id); this.events?.emit('queue.state', null, this.state()); this.kick(); };
    release.reason = reason;
    return release;
  }
  releasePauses(reason) { for (const [id, r] of [...this.leases]) if (r === reason) this.leases.delete(id); this.events?.emit('queue.state', null, this.state()); this.kick(); }
  pause() { this.paused = true; this.events?.emit('queue.state', null, this.state()); }
  resume() {
    this.paused = false;
    for (const t of this.tasks.list({states: ['paused'], limit: 1000}).reverse()) this.tasks.transition(t.id, 'queued', {reason: '继续'});
    this.events?.emit('queue.state', null, this.state()); this.kick();
  }
  state() { return {paused: this.paused, holds: [...this.leases.values()], runningTaskId: this.running, external: [...this.external.values()]}; }
  kick() { if (!this.pumping && !this.stopped) this.pump().catch(e => this.logger?.error('queue pump failed', {error: e.message})); }
  stop() { this.stopped = true; }
  /* ---------- 主循环 ---------- */
  async pump() {
    this.pumping = true;
    try {
      while (!this.paused && !this.leases.size && !this.stopped) {
        if (!this.running && this.activeTasks().length) { await this.resumeActive(); continue; }
        const next = this.tasks.nextQueued();
        if (!next) break;
        // 外部任务（ComfyUI 原生运行或其他客户端）存在时等待，不插队、不接管。
        let client;
        try { client = this.client(); } catch (e) { this.logger?.warn('queue: no client', {error: e.message}); break; }
        let q;
        try { q = parseQueue(await client.queue()); }
        catch (e) { this.events?.emit('queue.state', null, {...this.state(), waiting: 'service', error: e.message}); await this.sleep(this.externalWaitMs); continue; }
        const foreign = [...q.running, ...q.pending].filter(i => !this.tasks.byPromptId(i.promptId) && !(i.requestId && this.findByRequest(i.requestId)));
        this.external = new Map(foreign.map(i => [i.promptId, {promptId: i.promptId, running: q.running.some(r => r.promptId === i.promptId)}]));
        if (foreign.length) { this.events?.emit('queue.state', null, {...this.state(), waiting: 'external'}); await this.sleep(this.externalWaitMs); continue; }
        await this.runTask(next, client);
      }
    } finally {
      this.pumping = false;
      if (!this.activeTasks().length) { const w = this.idleWaiters.splice(0); w.forEach(r => r()); }
    }
  }
  findByRequest(requestId) { return this.tasks.db.get('SELECT id FROM tasks WHERE request_id = ?', requestId) ? true : false; }
  async runTask(task, client) {
    const token = new CancelToken(); this.tokens.set(task.id, token); this.running = task.id;
    const release = await this.gpuLock.acquire({owner: `task:${task.id}`});
    try {
      task = this.tasks.transition(task.id, 'preparing', {reason: '开始准备'});
      const snapshot = this.tasks.snapshotOf(task);
      let prompt;
      try { prompt = await this.prepare(task, snapshot, client, token); }
      catch (e) {
        if (token.cancelled) { this.tasks.transition(task.id, 'cancelled', {reason: '准备阶段取消'}); return; }
        this.tasks.transition(task.id, 'failed', {reason: '准备失败', patch: {error: {message: e.message, code: e.code ?? null}}}); return;
      }
      if (token.cancelled) { this.tasks.transition(task.id, 'cancelled', {reason: '提交前取消'}); return; }
      // 先持久化 submitting，再发请求。
      task = this.tasks.transition(task.id, 'submitting', {reason: '提交'});
      let response;
      try { response = await client.submit({prompt, clientId: task.clientId, requestId: task.requestId, promptId: task.requestId}); }
      catch (e) {
        if (e.code === 'INVALID_ARGUMENT') { this.tasks.transition(task.id, 'failed', {reason: '工作流校验失败', patch: {error: {message: e.message, nodeErrors: nodeErrorList(e.details?.nodeErrors)}}}); return; }
        // 响应丢失：不能重发，先核对。
        this.tasks.transition(task.id, 'reconciling', {reason: `提交响应丢失：${e.message}`});
        await this.reconcile(task.id);
        await this.follow(task.id, token);
        return;
      }
      const promptId = response?.prompt_id;
      if (!promptId) { this.tasks.transition(task.id, 'reconciling', {reason: '提交返回缺少 prompt_id'}); await this.reconcile(task.id); await this.follow(task.id, token); return; }
      if (response.node_errors && Object.keys(response.node_errors).length) this.logger?.warn('prompt accepted with node_errors', {taskId: task.id});
      this.tasks.transition(task.id, 'submitted', {reason: promptId === task.requestId ? '已提交（服务端采纳客户端 prompt_id）' : '已提交', patch: {comfyPromptId: promptId}});
      await this.follow(task.id, token);
    } finally {
      release(); this.tokens.delete(task.id); this.running = null;
    }
  }
  /** 跟踪直到终态：WS 事件加速，history 为准；轮询兜底。 */
  async follow(taskId, token) {
    for (;;) {
      let task = this.tasks.get(taskId);
      if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(task.state)) { if (task.state !== 'unknown') this.onTerminal(task); return task; }
      if (task.state === 'reconciling') { await this.reconcile(taskId); continue; }
      let client; try { client = this.client(); } catch { await this.sleep(this.pollMs); continue; }
      try {
        const h = await client.history(task.comfyPromptId);
        const entry = parseHistoryEntry(h?.[task.comfyPromptId]);
        if (entry?.state) { this.finish(task, entry); continue; }
        const q = parseQueue(await client.queue());
        const isRunning = q.running.some(i => i.promptId === task.comfyPromptId), isPending = q.pending.some(i => i.promptId === task.comfyPromptId);
        if (isRunning && task.state === 'submitted') this.tasks.transition(taskId, 'running', {reason: '后端开始执行'});
        if (!isRunning && !isPending && !entry) {
          // 既不在队列也不在 history：再确认一次，仍没有则 unknown，不重发。
          await this.sleep(this.pollMs);
          const again = parseHistoryEntry((await client.history(task.comfyPromptId))?.[task.comfyPromptId]);
          if (again?.state) { this.finish(task, again); continue; }
          const q2 = parseQueue(await client.queue());
          if (![...q2.running, ...q2.pending].some(i => i.promptId === task.comfyPromptId)) { this.tasks.transition(taskId, 'unknown', {reason: '后端队列与历史都找不到该任务（可能被清空或服务重启）'}); continue; }
        }
      } catch (e) {
        this.events?.emit('tasks.progress', taskId, {progress: {connection: 'lost', error: e.message}});
      }
      await this.sleep(this.pollMs);
    }
  }
  finish(task, entry) {
    const map = {succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled'};
    const to = map[entry.state];
    let from = this.tasks.get(task.id).state;
    if (from === 'submitted' && to !== 'cancelled') { this.tasks.transition(task.id, 'running', {reason: '历史记录显示已执行'}); from = 'running'; }
    this.tasks.transition(task.id, to, {reason: '以 history 终态确认', patch: {outputs: entry.outputs, error: entry.error, progress: {cachedNodes: entry.cachedNodes}}});
  }
  /** 第 5.4 节：核对后端 queue/history 再决定状态；无法证明则 unknown。 */
  async reconcile(taskId) {
    let task = this.tasks.get(taskId);
    if (task.state !== 'reconciling') task = this.tasks.transition(taskId, 'reconciling', {reason: '核对后端状态'});
    let client;
    try { client = this.client(); } catch (e) { this.tasks.transition(taskId, 'unknown', {reason: `无法核对：${e.message}`}); return this.tasks.get(taskId); }
    try {
      const candidates = [task.comfyPromptId, task.requestId].filter(Boolean);
      const q = parseQueue(await client.queue());
      const inQueue = [...q.running, ...q.pending].find(i => candidates.includes(i.promptId) || i.requestId === task.requestId);
      if (inQueue) {
        const running = q.running.some(i => i.promptId === inQueue.promptId);
        this.tasks.transition(taskId, running ? 'running' : 'submitted', {reason: '在后端队列中找到', patch: {comfyPromptId: inQueue.promptId}});
        return this.tasks.get(taskId);
      }
      for (const id of candidates) {
        const entry = parseHistoryEntry((await client.history(id))?.[id]);
        if (entry?.state) { this.tasks.setPromptId(taskId, id); this.tasks.transition(taskId, 'running', {reason: '在历史中找到'}); this.finish(this.tasks.get(taskId), entry); return this.tasks.get(taskId); }
      }
      const all = await client.history();
      for (const [pid, raw] of Object.entries(all ?? {})) {
        const entry = parseHistoryEntry(raw);
        if (entry?.requestId === task.requestId && entry.state) { this.tasks.setPromptId(taskId, pid); this.tasks.transition(taskId, 'running', {reason: '按 extra_data 标记在历史中找到'}); this.finish(this.tasks.get(taskId), entry); return this.tasks.get(taskId); }
      }
      this.tasks.transition(taskId, 'unknown', {reason: '队列与历史都没有该请求；无法证明是否已执行，未自动重发'});
    } catch (e) {
      this.tasks.transition(taskId, 'unknown', {reason: `核对失败：${e.message}`});
    }
    return this.tasks.get(taskId);
  }
  /** 启动恢复（Q10）：未提交 → paused；提交中/已提交 → 核对。 */
  async recoverOnStartup() {
    for (const t of this.tasks.list({states: ['queued', 'preparing'], limit: 1000})) this.tasks.transition(t.id, 'paused', {reason: '应用重启：未提交任务暂停，等待继续'});
    for (const t of this.tasks.list({states: ['submitting', 'submitted', 'running', 'reconciling'], limit: 100})) {
      if (t.state !== 'reconciling') this.tasks.transition(t.id, 'reconciling', {reason: '应用重启，核对后端状态'});
      await this.reconcile(t.id);
    }
    if (this.tasks.list({states: ['paused'], limit: 1}).length) this.paused = true;
  }
  /** 重启或断连后，继续跟踪仍在后端的任务 */
  async resumeActive() {
    for (const t of this.activeTasks()) {
      if (t.state === 'preparing') { this.tasks.transition(t.id, 'paused', {reason: '准备中断，暂停'}); continue; }
      const release = await this.gpuLock.acquire({owner: `follow:${t.id}`});
      this.running = t.id;
      try { await this.follow(t.id, new CancelToken()); } finally { release(); this.running = null; }
    }
  }
  /* ---------- 取消与重试（Q07） ---------- */
  async cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError(CODES.NOT_FOUND, '任务不存在。');
    if (['draft', 'queued', 'paused'].includes(task.state)) return this.tasks.transition(taskId, 'cancelled', {reason: '未提交前取消'});
    if (task.state === 'preparing') { this.tokens.get(taskId)?.cancel('用户取消'); return this.tasks.get(taskId); }
    if (task.state === 'unknown') return this.tasks.transition(taskId, 'cancelled', {reason: '用户确认放弃状态未知的任务（未向后端发送取消）'});
    if (!task.comfyPromptId) throw new AppError(CODES.INVALID_STATE, '任务正在提交，尚无后端编号；请等待核对完成后再取消。');
    const client = this.client();
    if (await client.jobCancelSupported?.()) {
      // D10：服务端支持按任务取消——原子操作，不会误中断后来开始的其他任务
      const r = await client.cancelJob(task.comfyPromptId);
      if (r.cancelled) { this.events?.emit('tasks.progress', taskId, {progress: {cancelRequested: true, mode: 'job'}}); return this.tasks.get(taskId); }
      return this.tasks.get(taskId);
    }
    const q = parseQueue(await client.queue());
    if (q.pending.some(i => i.promptId === task.comfyPromptId)) {
      await client.deleteQueued([task.comfyPromptId]);
      const after = parseQueue(await client.queue());
      if ([...after.pending, ...after.running].some(i => i.promptId === task.comfyPromptId)) throw new AppError(CODES.CONFLICT, '后端没有移除该排队任务，请稍后重试。');
      return this.tasks.transition(taskId, 'cancelled', {reason: '从后端队列移除'});
    }
    if (q.running.length && q.running[0].promptId === task.comfyPromptId) {
      // 重新确认正在运行的正是目标后发送带 prompt_id 的中断；老版本服务会忽略 prompt_id 做全局中断，
      // 但此刻运行的就是目标，风险仅限于极短的竞态窗口。
      // 旧后端：发送前再核对一次，缩小竞态窗口；无法做到原子，状态里标注 legacy
      const again = parseQueue(await client.queue());
      if (again.running[0]?.promptId !== task.comfyPromptId) throw new AppError(CODES.CONFLICT, '目标任务已结束或已切换，未发送中断以免影响其他任务。');
      await client.interrupt(task.comfyPromptId);
      this.events?.emit('tasks.progress', taskId, {progress: {cancelRequested: true, mode: 'legacy-interrupt'}});
      return this.tasks.get(taskId); // 终态以 history（execution_interrupted）为准
    }
    throw new AppError(CODES.INVALID_STATE, '后端当前运行的不是这个任务，为避免误中断其他任务，已禁用取消。', {details: {running: q.running.map(i => i.promptId)}});
  }
  retry(taskId) { const t = this.tasks.retry(taskId); this.kick(); return t; }
  /** unknown 任务：用户要求重新核对 */
  async recheck(taskId) { const t = this.tasks.get(taskId); if (t?.state !== 'unknown') throw new AppError(CODES.INVALID_STATE, '只有状态未知的任务需要核对。'); this.tasks.transition(taskId, 'reconciling', {reason: '用户要求重新核对'}); await this.reconcile(taskId); return this.tasks.get(taskId); }
  /* ---------- WebSocket 事件（Q05） ---------- */
  handleSocketEvent(message) {
    const d = message?.data ?? {}, pid = d.prompt_id;
    if (!pid) return;
    const task = this.tasks.byPromptId(pid);
    if (!task) { if (['execution_start', 'executing'].includes(message.type)) this.events?.emit('queue.external', pid, {type: message.type}); return; }
    if (message.type === 'execution_start' && task.state === 'submitted') this.tasks.transition(task.id, 'running', {reason: 'WebSocket: execution_start'});
    else if (message.type === 'progress') this.tasks.setProgress(task.id, {node: d.node ?? null, value: d.value, max: d.max});
    else if (message.type === 'executing' && d.node) this.tasks.setProgress(task.id, {node: d.node, value: null, max: null});
    else if (message.type === 'execution_cached') this.events?.emit('tasks.progress', task.id, {progress: {cachedNodes: d.nodes ?? []}});
    // 成功/错误/中断事件只作为“去查 history”的提示；终态由 follow() 依据 history 写入。
  }
}
/* ---------- Q10：批量展开 ---------- */
function expandBatch({prompts = [null], seeds = null, count = 1, seedStart = null, params = [{}]}, {max = 100} = {}) {
  const ps = prompts.length ? prompts : [null];
  const seedList = Array.isArray(seeds) && seeds.length ? seeds : Array.from({length: Math.max(1, count)}, (_, i) => (seedStart === null ? null : seedStart + i));
  const total = ps.length * seedList.length * params.length;
  if (total > max) throw new AppError(CODES.INVALID_ARGUMENT, `批量共 ${total} 个任务，超过上限 ${max}。`, {details: {total, max}});
  const out = [];
  for (const prompt of ps) for (const seed of seedList) for (const p of params) out.push({prompt, seed, params: p});
  return out;
}
module.exports = {QueueService, expandBatch, ACTIVE};
