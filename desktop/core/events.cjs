'use strict';
// F06：带序号事件。渲染端先读快照再订阅；检测到序号间隙时重新同步。
class EventBus {
  constructor({history = 500, now = () => new Date().toISOString()} = {}) {
    this.sequence = 0; this.listeners = new Set(); this.buffer = []; this.historySize = history; this.now = now;
  }
  emit(type, resourceId = null, data = {}) {
    const event = {sequence: ++this.sequence, type, resourceId, data, occurredAt: this.now()};
    this.buffer.push(event); if (this.buffer.length > this.historySize) this.buffer.shift();
    for (const fn of [...this.listeners]) { try { fn(event); } catch { /* 单个订阅者错误不影响其他订阅者 */ } }
    return event;
  }
  /** 订阅，返回取消函数。 */
  subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  /** 自某序号后的事件；若缓冲已丢失则返回 null，调用方需重新读取快照。 */
  since(sequence) {
    if (sequence >= this.sequence) return [];
    const first = this.buffer[0]?.sequence ?? this.sequence + 1;
    if (sequence + 1 < first) return null;
    return this.buffer.filter(e => e.sequence > sequence);
  }
  get listenerCount() { return this.listeners.size; }
}
/** 客户端侧序号跟踪：返回 'ok' | 'duplicate' | 'gap'。 */
function createSequenceTracker(start = 0) {
  let last = start;
  return {
    accept(event) { if (event.sequence <= last) return 'duplicate'; if (event.sequence !== last + 1) { return 'gap'; } last = event.sequence; return 'ok'; },
    reset(sequence) { last = sequence; },
    get last() { return last; },
  };
}
module.exports = {EventBus, createSequenceTracker};
