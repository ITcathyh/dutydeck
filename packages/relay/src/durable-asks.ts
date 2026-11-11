import { createHash } from 'node:crypto';
import { RelayError, type RelayAskRecord, type RelayAskStore, type RelayEventPublisher } from './types.js';
import type { RelayAskContext, RelayAskOutcome } from './ask-broker.js';

export type RelayContinuation = 'available' | 'ended' | 'unknown';
export type RelayAskLifecycleWatcher = (record: RelayAskRecord, changed: () => void) => () => void;
export type RelayContinuationGuard = (owner?: Pick<RelayAskRecord, 'taskId' | 'attemptId'>) => RelayContinuation;
export type RelayContinuationChecker = ((record: RelayAskRecord) => Promise<RelayContinuation>) & { capture?: (sessionId: string) => RelayContinuationGuard };
export function relayAskId(sessionId: string, requestId: string) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) {
    throw new RelayError('RELAY_INVALID_REQUEST_ID', 'requestId 必须是 1-128 个字母、数字或 _ . : -。', 400);
  }
  return 'ask_' + createHash('sha256').update(JSON.stringify(['dutydeck-relay-ask-v1', sessionId, requestId])).digest('hex');
}
const ended = (id: string, reason = '原执行轮已结束或结果未知；可用 ask-result 只读查看，不能据此继续执行。'): RelayAskOutcome => ({ status: 'cancelled', askId: id, reason });
const outcome = (record: RelayAskRecord): RelayAskOutcome => record.status === 'answered'
  ? { status: 'answered', askId: record.id, answer: record.answer! }
  : record.status === 'expired' ? { status: 'expired', askId: record.id }
  : ended(record.id, record.reason);
type Pending = { record: RelayAskRecord; timer?: NodeJS.Timeout; unwatch?: () => void; waiters: Set<() => void> };

/** The durable question owns its deadline; HTTP connections only own waiters. */
export class DurableRelayAsks {
  private readonly pending = new Map<string, Pending>();
  private readonly writes = new Set<Promise<unknown>>();
  private readonly errors: unknown[] = [];
  private closed = false;
  private watch?: RelayAskLifecycleWatcher;
  // Hosts must prove owned attempts. Idle requests still require host session checks at the boundary.
  checkContinuation: RelayContinuationChecker = async record => record.taskId ? 'unknown' : 'available';

  constructor(private readonly publisher: RelayEventPublisher, private readonly store?: RelayAskStore) {}

  setLifecycleWatcher(watch?: RelayAskLifecycleWatcher) {
    this.watch = watch;
    for (const entry of this.pending.values()) this.watchEntry(entry);
  }
  private watchEntry(entry: Pending) {
    entry.unwatch?.();
    entry.unwatch = this.closed ? undefined : this.watch?.(entry.record, () => this.track(this.refresh(entry.record.sessionId)));
  }
  private storage() {
    if (!this.store) throw new RelayError('RELAY_DURABLE_UNAVAILABLE', '持久提问需要原子存储。', 503);
    return this.store;
  }
  async has(id: string) { return Boolean((this.pending.get(id)?.record ?? await this.store?.get(id))?.mode === 'return-answer'); }
  get(id: string) { return this.pending.get(id)?.record; }
  listPending(sessionId?: string) { return [...this.pending.values()].filter(entry => !sessionId || entry.record.sessionId === sessionId).map(entry => ({ ...entry.record })); }

  restore(record: RelayAskRecord) {
    if (record.status !== 'pending') return;
    if (!this.pending.has(record.id)) {
      const entry: Pending = { record, waiters: new Set() };
      this.pending.set(record.id, entry);
      this.watchEntry(entry);
      if (!this.closed) entry.timer = setTimeout(() => this.track(this.settle(record, { ...record, status: 'expired' })), Math.max(0, Date.parse(record.expiresAt) - Date.now()));
      entry.timer?.unref?.();
    }
    return this.pending.get(record.id);
  }

  private notify(record: RelayAskRecord) {
    const entry = this.pending.get(record.id);
    if (!entry) return;
    entry.record = record;
    if (record.status === 'pending') return;
    clearTimeout(entry.timer); entry.unwatch?.(); this.pending.delete(record.id);
    for (const wake of entry.waiters) wake();
  }
  private async settle(previous: RelayAskRecord, next: RelayAskRecord) {
    const store = this.storage();
    if (!await store.compareAndSet(previous, next)) {
      const authoritative = await store.get(previous.id);
      if (!authoritative) throw new RelayError('RELAY_ASK_NOT_FOUND', '提问记录不存在。', 404);
      this.notify(authoritative);
      return authoritative;
    }
    this.notify(next);
    return next;
  }
  private async validate(record: RelayAskRecord) {
    if (record.status !== 'pending') return record;
    if (Date.parse(record.expiresAt) <= Date.now()) return this.settle(record, { ...record, status: 'expired' });
    const continuation = await this.checkContinuation(record);
    if (continuation === 'ended') return this.settle(record, { ...record, status: 'cancelled', reason: '原执行轮已结束或权限已撤销，未继续执行。' });
    // Unverifiable authority stops connected callers without destroying a still-live question.
    if (continuation === 'unknown') for (const wake of this.pending.get(record.id)?.waiters ?? []) wake();
    return record;
  }
  async refresh(sessionId?: string) {
    for (const entry of [...this.pending.values()]) {
      if (!sessionId || sessionId === entry.record.sessionId) {
        const current = await this.storage().get(entry.record.id);
        if (current) this.notify(await this.validate(current));
      }
    }
  }
  async register(input: { sessionId: string; requestId?: string; question: string; questionBody?: string; timeoutMs: number; choices?: RelayAskRecord['choices']; multiple?: boolean }, context: RelayAskContext, prepared: () => void, cancellation: () => string | undefined) {
    const store = this.storage();
    const id = relayAskId(input.sessionId, input.requestId!);
    const intent = {
      version: 1 as const, mode: 'return-answer' as const, requestId: input.requestId!, sessionId: input.sessionId,
      question: input.question, ...(input.questionBody !== undefined ? { questionBody: input.questionBody } : {}), timeoutMs: input.timeoutMs,
      ...(input.choices ? { choices: input.choices } : {}), ...(input.multiple ? { multiple: true } : {}),
      ...(context.taskId ? { taskId: context.taskId } : {}), ...(context.attemptId ? { attemptId: context.attemptId } : {})
    };
    const proposed: RelayAskRecord = { ...intent, id, status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + input.timeoutMs).toISOString() };
    const inserted = await store.compareAndSet(undefined, proposed);
    const record = inserted ? proposed : await store.get(id);
    const keys = ['version', 'mode', 'requestId', 'sessionId', 'question', 'questionBody', 'timeoutMs', 'choices', 'multiple', 'taskId', 'attemptId'] as const;
    if (!record || keys.some(key => JSON.stringify(record[key]) !== JSON.stringify(intent[key]))) {
      throw new RelayError('RELAY_ASK_CONFLICT', 'requestId 已绑定其他问题、选项、期限或执行轮；原问题未改动。', 409);
    }
    this.restore(record);
    const reason = cancellation();
    const current = reason && record.status === 'pending' ? await this.settle(record, { ...record, status: 'cancelled', reason }) : await this.validate(record);
    prepared();
    const detached = new AbortController();
    const signal = context.signal ? AbortSignal.any([context.signal, detached.signal]) : detached.signal;
    const waiting = this.wait(input.sessionId, input.requestId!, signal);
    void waiting.catch(() => undefined);
    try {
      if (inserted && current.status === 'pending' && await this.checkContinuation(current) === 'available' && !this.closed && !context.signal?.aborted && !cancellation()) {
        // Saving the question precedes its single publication attempt. Reconnect never republishes it.
        await Promise.race([this.publisher.publish(record.sessionId, { kind: 'ask', askId: id, text: record.questionBody ?? record.question,
          ...(record.choices ? { choices: record.choices } : {}), ...(record.multiple ? { multiple: true } : {}) }), waiting.then(() => undefined)]);
      }
      return await waiting;
    } finally { detached.abort(); }
  }

  async result(sessionId: string, requestId: string) {
    const record = await this.storage().get(relayAskId(sessionId, requestId));
    if (!record || record.mode !== 'return-answer') throw new RelayError('RELAY_ASK_NOT_FOUND', '未知的持久提问。', 404);
    // A historical answer is evidence, never permission to resume an ended attempt.
    return { ...record, askId: record.id, continuation: await this.checkContinuation(record) };
  }
  async wait(sessionId: string, requestId: string, signal?: AbortSignal, ready?: Promise<void>): Promise<RelayAskOutcome> {
    const guard = this.checkContinuation.capture?.(sessionId);
    await ready;
    const initial = await this.result(sessionId, requestId);
    if (this.closed || signal?.aborted) return ended(initial.id, '等待连接已关闭；使用 ask-result 查询或 ask-wait 续等同一 requestId。');
    if (initial.continuation !== 'available') { const stored = await this.storage().get(initial.id); if (stored) await this.validate(stored); return ended(initial.id); }
    const record = await this.storage().get(initial.id) ?? initial;
    if (record.status !== 'pending') {
      const continuation = await this.checkContinuation(record);
      return !this.closed && !signal?.aborted && continuation === 'available' && (!guard || guard(record) === 'available') ? outcome(record) : ended(record.id);
    }
    const entry = this.restore(record)!;
    await new Promise<void>((resolve, reject) => {
      const wake = () => { entry.waiters.delete(wake); signal?.removeEventListener('abort', wake); resolve(); };
      entry.waiters.add(wake);
      signal?.addEventListener('abort', wake, { once: true });
      if (this.closed || signal?.aborted || entry.record.status !== 'pending') wake();
      // Subscribe before validation: an unknown result must wake this caller too.
      void this.storage().get(record.id).then(current => current && this.validate(current)).then(current => { if (current) this.notify(current); }, error => { entry.waiters.delete(wake); signal?.removeEventListener('abort', wake); reject(error); });
    });
    if (signal?.aborted || this.closed) { if (!this.closed) await this.validate(await this.storage().get(record.id) ?? record); return ended(record.id, '等待连接已关闭；使用 ask-result 查询或 ask-wait 续等同一 requestId。'); }
    const latest = await this.result(sessionId, requestId);
    return !this.closed && !signal?.aborted && latest.continuation === 'available' && (!guard || guard(latest) === 'available') ? outcome(latest) : ended(latest.id);
  }
  async answer(id: string, answer: string, options: { sessionId?: string; beforeClaim?: () => Promise<void>; handledBy?: string }) {
    let previous = await this.storage().get(id);
    if (!previous || options.sessionId && options.sessionId !== previous.sessionId) throw new RelayError('RELAY_ASK_NOT_FOUND', '未知的提问。', 404);
    previous = await this.validate(previous);
    if (previous.status !== 'pending' || this.closed) throw new RelayError('RELAY_ASK_SETTLED', '提问已经结束，无法回答。', 409);
    const text = answer.trim();
    if (!text) throw new RelayError('RELAY_ANSWER_REQUIRED', '回答内容不能为空。', 400);
    await options.beforeClaim?.();
    if (Date.parse(previous.expiresAt) <= Date.now() || await this.checkContinuation(previous) !== 'available') { await this.validate(previous); throw new RelayError('RELAY_ASK_SETTLED', '原执行轮已结束或无法核实。', 409); }
    const next: RelayAskRecord = { ...previous, status: 'answered', answer: text, ...(options.handledBy ? { handledBy: options.handledBy } : {}) };
    // No answer is exposed before its CAS commits; a failed display never reopens the question.
    let committed: boolean;
    try { committed = await this.storage().compareAndSet(previous, next); }
    catch (error) {
      const stored = await this.storage().get(id);
      if (JSON.stringify(stored) !== JSON.stringify(next)) throw error;
      committed = true;
    }
    if (!committed) { const stored = await this.storage().get(id); if (stored) this.notify(stored); throw new RelayError('RELAY_ASK_SETTLED', '提问已被其他回答或取消。', 409); }
    this.notify(next);
    // Display is derived. The saved answer remains queryable even when publication fails.
    await this.publisher.publish(next.sessionId, { kind: 'answer', text, askId: id, eventId: `relay_answer_${id}`, ...(next.handledBy ? { handledBy: next.handledBy } : {}) }).catch(() => undefined);
    return next;
  }
  async cancelSession(sessionId: string, reason: string) {
    for (const { record } of [...this.pending.values()]) if (record.sessionId === sessionId) await this.settle(record, { ...record, status: 'cancelled', reason });
  }
  close() {
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.unwatch?.(); for (const wake of [...entry.waiters]) wake(); }
  }
  private track(write: Promise<unknown>) {
    this.writes.add(write);
    void write.then(() => this.writes.delete(write), error => { this.writes.delete(write); this.errors.push(error); });
  }
  async flush() { await Promise.allSettled([...this.writes]); if (this.errors.length) throw new AggregateError(this.errors.splice(0), 'Relay question persistence failed'); }
}
