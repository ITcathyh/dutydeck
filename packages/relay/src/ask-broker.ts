import { randomUUID } from 'node:crypto';
import { RelayError, type RelayAskRecord, type RelayAskStore, type RelayEventPublisher } from './types.js';

export const relayAskDefaultTimeoutMs = 300_000;
export const relayAskMinTimeoutMs = 1_000;
export const relayAskMaxTimeoutMs = 3_600_000;

export type RelayAskOutcome =
  | { status: 'answered'; answer: string; askId: string }
  | { status: 'expired'; askId: string }
  | { status: 'cancelled'; askId: string; reason: string };

interface PendingAsk {
  record: RelayAskRecord;
  timer?: NodeJS.Timeout;
  resolve: (outcome: RelayAskOutcome) => void;
  reject: (error: unknown) => void;
  outcome: Promise<RelayAskOutcome>;
  settlement?: Promise<void>;
  answerPublishStarted?: boolean;
}

/** Persistent history never restores a lost HTTP waiter or grants permission to answer it. */
export class RelayAskBroker {
  private readonly pending = new Map<string, PendingAsk>();
  private readonly history = new Map<string, RelayAskRecord>();
  private readonly writes = new Set<Promise<unknown>>();
  private readonly ready: Promise<void>;
  private readonly writeErrors: unknown[] = [];
  private closed = false;

  constructor(private readonly publisher: RelayEventPublisher, private readonly store?: RelayAskStore) {
    this.ready = this.recover();
  }

  async initialize() { await this.ready; }

  private async recover() {
    if (!this.store) return;
    for (const initial of await this.store.list()) {
      let record: RelayAskRecord | undefined = initial;
      for (let attempt = 0; record && attempt < 3; attempt++) {
        if (record.status !== 'pending' && record.status !== 'answering') break;
        const cancelled: RelayAskRecord = { ...record, status: 'cancelled', reason: 'Dutydeck 服务已重启，原提问连接失效，请重新提问。' };
        if (await this.store.compareAndSet(record, cancelled)) { record = cancelled; break; }
        record = await this.store.get(record.id);
      }
      if (record?.status === 'pending' || record?.status === 'answering') throw new RelayError('RELAY_RECOVERY_CONFLICT', '未能收敛上次运行的提问记录。', 503);
      if (record) this.history.set(record.id, record);
    }
  }

  async register(input: { sessionId: string; question: string; timeoutMs?: number }): Promise<RelayAskOutcome> {
    await this.ready;
    if (this.closed) throw new RelayError('RELAY_CLOSED', 'Dutydeck 提问通道已关闭。', 409);
    const question = input.question.trim();
    if (!question) throw new RelayError('RELAY_QUESTION_REQUIRED', '提问内容不能为空。', 400);
    const timeoutMs = input.timeoutMs ?? relayAskDefaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < relayAskMinTimeoutMs || timeoutMs > relayAskMaxTimeoutMs) {
      throw new RelayError('RELAY_INVALID_TIMEOUT', '超时必须是 ' + relayAskMinTimeoutMs + '-' + relayAskMaxTimeoutMs + ' 之间的整数毫秒。', 400);
    }
    const record: RelayAskRecord = {
      id: 'ask_' + randomUUID(), sessionId: input.sessionId, question, status: 'pending',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + timeoutMs).toISOString()
    };
    if (this.store && !await this.store.compareAndSet(undefined, record)) throw new RelayError('RELAY_ASK_CONFLICT', '无法登记提问。', 409);
    let resolve!: PendingAsk['resolve'];
    let reject!: PendingAsk['reject'];
    const outcome = new Promise<RelayAskOutcome>((done, failed) => { resolve = done; reject = failed; });
    void outcome.catch(() => undefined);
    const ask: PendingAsk = { record, resolve, reject, outcome };
    this.pending.set(record.id, ask);
    ask.timer = setTimeout(() => {
      if (ask.record.status === 'pending') this.track(this.finish(ask, { status: 'expired', askId: record.id }));
    }, Math.max(0, Date.parse(record.expiresAt) - Date.now()));
    ask.timer.unref?.();
    // Register before publishing so a reply arriving during publish can find the live request.
    try {
      if (this.closed) await this.finish(ask, { status: 'cancelled', askId: record.id, reason: 'Dutydeck 服务已关闭' });
      else await Promise.race([
        this.publisher.publish(input.sessionId, { kind: 'ask', text: question, askId: record.id }),
        ask.outcome.then(() => undefined)
      ]);
    } catch (error) {
      if (ask.record.status === 'pending') await this.finish(ask, { status: 'cancelled', askId: record.id, reason: '提问未能发送。' });
      throw error;
    }
    return outcome;
  }

  async answer(askId: string, answer: string, options: { sessionId?: string } = {}): Promise<RelayAskRecord> {
    await this.ready;
    const ask = this.pending.get(askId);
    const known = ask?.record ?? this.history.get(askId) ?? await this.store?.get(askId);
    if (!known || options.sessionId && options.sessionId !== known.sessionId) throw new RelayError('RELAY_ASK_NOT_FOUND', '未知的提问：' + askId, 404);
    if (!ask || ask.settlement || ask.record.status !== 'pending') throw new RelayError('RELAY_ASK_SETTLED', '提问已经结束或正在提交答案，无法重复回答。', 409);
    const text = answer.trim();
    if (!text) throw new RelayError('RELAY_ANSWER_REQUIRED', '回答内容不能为空。', 400);
    if (Date.parse(ask.record.expiresAt) <= Date.now()) {
      await this.finish(ask, { status: 'expired', askId });
      throw new RelayError('RELAY_ASK_SETTLED', '提问已经过期。', 409);
    }
    const previous = ask.record;
    // Claim before any await; timeout, stop and another answer cannot overtake the winner.
    ask.record = { ...previous, status: 'answering' };
    clearTimeout(ask.timer);
    ask.timer = undefined;
    try {
      if (this.store && !await this.store.compareAndSet(previous, ask.record)) throw new RelayError('RELAY_ASK_SETTLED', '提问状态已经变化。', 409);
      // close/cancel may settle the request while the claim CAS is in flight.
      // Do not publish an answer after that cancellation wins.
      if (this.closed || ask.settlement || this.pending.get(askId) !== ask || ask.record.status !== 'answering') {
        if (this.pending.get(askId) === ask && !ask.settlement) {
          await this.finish(ask, { status: 'cancelled', askId, reason: '提问已结束，答案未提交。' });
        }
        throw new RelayError('RELAY_ASK_SETTLED', '提问已经结束，答案未继续提交。', 409);
      }
      ask.answerPublishStarted = true;
      await Promise.race([
        this.publisher.publish(ask.record.sessionId, { kind: 'answer', text, askId }),
        ask.outcome.then(() => { throw new RelayError('RELAY_ASK_SETTLED', '提问已结束，答案未继续提交。', 409); })
      ]);
      await this.finish(ask, { status: 'answered', answer: text, askId });
      const result = this.history.get(askId)!;
      if (result.status !== 'answered') throw new RelayError('RELAY_ASK_SETTLED', '提问已结束，答案未继续提交。', 409);
      return result;
    } catch (error) {
      if (this.pending.has(askId)) await this.finish(ask, { status: 'cancelled', askId, reason: '答案提交失败，请重新提问。' });
      throw error;
    }
  }

  listPending(sessionId?: string): RelayAskRecord[] {
    return [...this.pending.values()].filter(ask => (!sessionId || ask.record.sessionId === sessionId) && ask.record.status === 'pending' && !ask.settlement).map(ask => ({ ...ask.record }));
  }

  get(askId: string): RelayAskRecord | undefined {
    const record = this.pending.get(askId)?.record ?? this.history.get(askId);
    return record ? { ...record } : undefined;
  }

  cancelSession(sessionId: string, reason = '会话已结束') {
    for (const ask of [...this.pending.values()]) {
      if (ask.record.sessionId === sessionId && (ask.record.status === 'pending' || ask.record.status === 'answering' && !ask.answerPublishStarted)) {
        this.track(this.finish(ask, { status: 'cancelled', askId: ask.record.id, reason }));
      }
    }
  }

  close(reason = 'Dutydeck 服务已关闭') {
    this.closed = true;
    for (const ask of [...this.pending.values()]) {
      if (ask.record.status === 'pending') this.track(this.finish(ask, { status: 'cancelled', askId: ask.record.id, reason }));
      else if (ask.record.status === 'answering' && !ask.timer) {
        // Give an accepted answer a short chance to finish, then release both HTTP requests.
        ask.timer = setTimeout(() => this.track(this.finish(ask, { status: 'cancelled', askId: ask.record.id, reason })), 1_000);
        this.track(ask.outcome.then(() => undefined));
      }
    }
  }

  async flush() {
    await Promise.allSettled([...this.writes]);
    const errors = this.writeErrors.splice(0);
    if (errors.length) throw new AggregateError(errors, 'Relay question persistence failed');
  }

  private track(write: Promise<unknown>) {
    this.writes.add(write);
    void write.then(() => this.writes.delete(write), error => { this.writes.delete(write); this.writeErrors.push(error); });
  }

  private finish(ask: PendingAsk, outcome: RelayAskOutcome): Promise<void> {
    if (ask.settlement) return ask.settlement;
    if (!this.pending.has(ask.record.id)) return Promise.resolve();
    clearTimeout(ask.timer);
    ask.timer = undefined;
    const previous = ask.record;
    const proposed: RelayAskRecord = {
      ...previous, status: outcome.status,
      ...(outcome.status === 'answered' ? { answer: outcome.answer } : {}),
      ...(outcome.status === 'cancelled' ? { reason: outcome.reason } : {})
    };
    ask.settlement = (async () => {
      let committed = proposed;
      if (this.store && !await this.store.compareAndSet(previous, proposed)) {
        const authoritative = await this.store.get(previous.id);
        if (!authoritative || authoritative.status === 'pending' || authoritative.status === 'answering') throw new RelayError('RELAY_ASK_CONFLICT', '提问状态未能持久保存，连接已结束，请重新提问。', 409);
        committed = authoritative;
      }
      const committedOutcome: RelayAskOutcome = committed.status === 'answered'
        ? { status: 'answered', askId: committed.id, answer: committed.answer! }
        : committed.status === 'expired' ? { status: 'expired', askId: committed.id }
        : { status: 'cancelled', askId: committed.id, reason: committed.reason ?? '提问已结束' };
      ask.record = committed;
      this.pending.delete(committed.id);
      this.history.set(committed.id, committed);
      ask.resolve(committedOutcome);
    })().catch(error => {
      this.pending.delete(previous.id);
      ask.reject(error);
      throw error;
    });
    return ask.settlement;
  }
}
