import { randomUUID } from 'node:crypto';
import { DurableRelayAsks, relayAskId, type RelayContinuationChecker, type RelayAskLifecycleWatcher } from './durable-asks.js';
import { RelayError, type RelayAskChoice, type RelayAskRecord, type RelayAskStore, type RelayEventPublisher } from './types.js';

export const relayAskDefaultTimeoutMs = 300_000;
export const relayAskMinTimeoutMs = 1_000;
export const relayAskMaxTimeoutMs = 3_600_000;
export const relayAskDurableMaxTimeoutMs = 86_400_000;
/** 结构化选项的 schema 级上限；IM 卡片侧还有自己的整卡预算，可能渲染更少 */
export const relayAskMaxChoices = 50;
export const relayAskChoiceMaxLength = 200;

export type RelayAskOutcome =
  | { status: 'deferred'; askId: string; reason: string }
  | { status: 'answered'; answer: string; askId: string }
  | { status: 'expired'; askId: string }
  | { status: 'cancelled'; askId: string; reason: string };

/**
 * 校验并归一化结构化选项。非法形态直接 400——这是 HTTP 边界后的唯一收口，
 * 持久化记录与发布事件都只可能携带这里归一化过的 choices。
 * 以 value（缺省时为 label）去重，否则卡片端会出现两个点按结果完全相同的选项。
 */
function normalizeChoices(input: unknown): RelayAskChoice[] | undefined {
  if (input === undefined) return undefined;
  const invalid = (message: string) => new RelayError('RELAY_INVALID_CHOICES', message, 400);
  if (!Array.isArray(input) || input.length === 0 || input.length > relayAskMaxChoices) {
    throw invalid(`提问选项必须是 1-${relayAskMaxChoices} 个的数组。`);
  }
  const choices: RelayAskChoice[] = [];
  const answers = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== 'object') throw invalid('提问选项必须包含非空 label。');
    const label = String((item as { label?: unknown }).label ?? '').trim();
    if (!label || label.length > relayAskChoiceMaxLength) {
      throw invalid(`选项文案长度必须在 1-${relayAskChoiceMaxLength} 字符之间。`);
    }
    const rawValue = (item as { value?: unknown }).value;
    let value: string | undefined;
    if (rawValue !== undefined && rawValue !== null) {
      const trimmed = String(rawValue).trim();
      // 显式传空串等价于不传 value，以 label 作为答案文本，避免卡片端出现空值选项。
      if (trimmed.length > relayAskChoiceMaxLength) throw invalid(`选项值长度必须在 1-${relayAskChoiceMaxLength} 字符之间。`);
      value = trimmed || undefined;
    }
    const answer = value ?? label;
    if (answers.has(answer)) throw invalid('选项的 value（未提供 value 时为文案）不能重复。');
    answers.add(answer);
    choices.push(value ? { label, value } : { label });
  }
  return choices;
}

export interface RelayDeferredAsk { sessionId: string; question: string; choices: RelayAskChoice[]; multiple?: boolean }
export type RelayDeferredHandler = (input: RelayDeferredAsk, context: RelayAskContext) => Promise<Extract<RelayAskOutcome, { status: 'deferred' }> | undefined>;

export interface RelayAskContext {
  taskId?: string;
  attemptId?: string;
  signal?: AbortSignal;
}

interface AskRegistration {
  sessionId: string;
  prepared(): void;
  reason?: string;
  durableCancellationReason?: string;
  ask?: PendingAsk;
}

interface PendingAsk {
  record: RelayAskRecord;
  timer?: NodeJS.Timeout;
  resolve: (outcome: RelayAskOutcome) => void;
  reject: (error: unknown) => void;
  outcome: Promise<RelayAskOutcome>;
  settlement?: Promise<void>;
  answerPublishStarted?: boolean;
}

/** Legacy HTTP questions and durable return-answer requests share the same CAS store. */
export class RelayAskBroker {
  private readonly registrations = new Set<AskRegistration>();
  private readonly pending = new Map<string, PendingAsk>();
  private readonly history = new Map<string, RelayAskRecord>();
  private readonly writes = new Set<Promise<unknown>>();
  private readonly ready: Promise<void>;
  private readonly writeErrors: unknown[] = [];
  private closed = false;
  private readonly durable: DurableRelayAsks;
  private readonly deferredHandlers = new Set<RelayDeferredHandler>();

  addDeferredHandler(handler: RelayDeferredHandler) {
    this.deferredHandlers.add(handler);
    return () => { this.deferredHandlers.delete(handler); };
  }

  constructor(private readonly publisher: RelayEventPublisher, private readonly store?: RelayAskStore) {
    this.durable = new DurableRelayAsks(publisher, store);
    this.ready = this.recover();
  }

  async initialize() { await this.ready; }

  setContinuationChecker(check: RelayContinuationChecker, watch?: RelayAskLifecycleWatcher) { this.durable.checkContinuation = check; this.durable.setLifecycleWatcher(watch); }
  async refreshPending(sessionId?: string) { await this.ready; await this.durable.refresh(sessionId); }
  async result(sessionId: string, requestId: string) { await this.ready; return this.durable.result(sessionId, requestId); }
  wait(sessionId: string, requestId: string, signal?: AbortSignal) { return this.durable.wait(sessionId, requestId, signal, this.ready); }

  private get durableHistory() { return Boolean(this.store?.getSync && this.store.listUnsettled); }

  private async recover() {
    if (!this.store) return;
    for (const initial of await (this.durableHistory ? this.store.listUnsettled!() : this.store.list())) {
      if (initial.mode === 'return-answer' && initial.requestId) { await this.durable.restore(initial); continue; }
      let record: RelayAskRecord | undefined = initial;
      for (let attempt = 0; record && attempt < 3; attempt++) {
        if (record.status !== 'pending' && record.status !== 'answering') break;
        const cancelled: RelayAskRecord = { ...record, status: 'cancelled', reason: 'Dutydeck 服务已重启，原提问连接失效，请重新提问。' };
        if (await this.store.compareAndSet(record, cancelled)) { record = cancelled; break; }
        record = await this.store.get(record.id);
      }
      if (record?.status === 'pending' || record?.status === 'answering') throw new RelayError('RELAY_RECOVERY_CONFLICT', '未能收敛上次运行的提问记录。', 503);
      if (record && !this.durableHistory) this.history.set(record.id, record);
    }
  }

  register(input: { sessionId: string; requestId?: string; question: string; questionBody?: string; timeoutMs?: number; choices?: RelayAskChoice[]; multiple?: boolean }, context: RelayAskContext = {}): Promise<RelayAskOutcome> {
    const guard = this.durable.checkContinuation.capture?.(input.sessionId);
    // Register the cancellation fence before readiness or the first storage await.
    let prepared!: () => void;
    this.track(new Promise<void>(resolve => { prepared = resolve; }));
    const registration: AskRegistration = { sessionId: input.sessionId, prepared };
    this.registrations.add(registration);
    const cancel = () => this.cancelRegistration(registration, typeof context.signal?.reason === 'string' ? context.signal.reason : '任务已结束');
    context.signal?.addEventListener('abort', cancel, { once: true });
    if (context.signal?.aborted) cancel();
    return this.registerAsk(input, context, registration).finally(() => {
      registration.prepared();
      this.registrations.delete(registration);
      context.signal?.removeEventListener('abort', cancel);
    }).then(outcome => outcome.status === 'answered' && (input.requestId !== undefined && (this.closed || context.signal?.aborted) || guard && guard(context) !== 'available')
      ? { status: 'cancelled', askId: outcome.askId, reason: '原执行轮已结束或无法核实。' } : outcome);
  }

  private async registerAsk(input: { sessionId: string; requestId?: string; question: string; questionBody?: string; timeoutMs?: number; choices?: RelayAskChoice[]; multiple?: boolean }, context: RelayAskContext, registration: AskRegistration): Promise<RelayAskOutcome> {
    await this.ready;
    if (this.closed) throw new RelayError('RELAY_CLOSED', 'Dutydeck 提问通道已关闭。', 409);
    const question = input.question.trim();
    if (!question) throw new RelayError('RELAY_QUESTION_REQUIRED', '提问内容不能为空。', 400);
    const timeoutMs = input.timeoutMs ?? relayAskDefaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < relayAskMinTimeoutMs || timeoutMs > (input.requestId === undefined ? relayAskMaxTimeoutMs : relayAskDurableMaxTimeoutMs)) {
      throw new RelayError('RELAY_INVALID_TIMEOUT', '超时必须是 ' + relayAskMinTimeoutMs + '-' + (input.requestId === undefined ? relayAskMaxTimeoutMs : relayAskDurableMaxTimeoutMs) + ' 之间的整数毫秒。', 400);
    }
    // multiple 只在 choices 存在时成立，避免「多选但没有选项」的自相矛盾记录。
    const choices = normalizeChoices(input.choices);
    const multiple = choices !== undefined && input.multiple === true;
    const existingDurable = input.requestId !== undefined && await this.durable.has(relayAskId(input.sessionId, input.requestId));
    if (choices && !registration.reason && !existingDurable) {
      for (const handler of this.deferredHandlers) {
        const deferred = await handler({ sessionId: input.sessionId, question: input.questionBody ?? question, choices, ...(multiple ? { multiple } : {}) }, context);
        if (deferred) return deferred;
      }
    }
    if (input.requestId !== undefined) {
      return this.durable.register({ ...input, question, timeoutMs, choices, multiple }, context, registration.prepared, () => registration.durableCancellationReason);
    }
    const record: RelayAskRecord = {
      id: 'ask_' + randomUUID(), sessionId: input.sessionId, question, status: 'pending',
      ...(context.taskId ? { taskId: context.taskId } : {}),
      ...(context.attemptId ? { attemptId: context.attemptId } : {}),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      ...(choices ? { choices } : {}),
      ...(multiple ? { multiple: true } : {})
    };
    if (this.store && !await this.store.compareAndSet(undefined, record)) throw new RelayError('RELAY_ASK_CONFLICT', '无法登记提问。', 409);
    let resolve!: PendingAsk['resolve'];
    let reject!: PendingAsk['reject'];
    const outcome = new Promise<RelayAskOutcome>((done, failed) => { resolve = done; reject = failed; });
    void outcome.catch(() => undefined);
    const ask: PendingAsk = { record, resolve, reject, outcome };
    registration.ask = ask;
    this.pending.set(record.id, ask);
    ask.timer = setTimeout(() => {
      if (ask.record.status === 'pending') this.track(this.finish(ask, { status: 'expired', askId: record.id }));
    }, Math.max(0, Date.parse(record.expiresAt) - Date.now()));
    ask.timer.unref?.();
    // Register before publishing so a reply arriving during publish can find the live request.
    try {
      if (registration.reason || this.closed) await this.finish(ask, { status: 'cancelled', askId: record.id, reason: registration.reason ?? 'Dutydeck 服务已关闭' });
      else {
        registration.prepared();
        await Promise.race([
          this.publisher.publish(input.sessionId, {
            kind: 'ask', text: question, askId: record.id,
            ...(record.choices ? { choices: record.choices } : {}),
            ...(record.multiple ? { multiple: true } : {})
          }),
          ask.outcome.then(() => undefined)
        ]);
      }
    } catch (error) {
      if (ask.record.status === 'pending') await this.finish(ask, { status: 'cancelled', askId: record.id, reason: '提问未能发送。' });
      throw error;
    }
    registration.prepared();
    return outcome;
  }

  async answer(askId: string, answer: string, options: { sessionId?: string; beforeClaim?: () => Promise<void>; handledBy?: string } = {}): Promise<RelayAskRecord> {
    await this.ready;
    // A live question is read and claimed without another await after this
    // policy check. Readiness may have waited while permission was revoked.
    if (options.beforeClaim) await options.beforeClaim();
    if (await this.durable.has(askId)) return this.durable.answer(askId, answer, options);
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
    ask.record = { ...previous, status: 'answering', ...(options.handledBy ? { handledBy: options.handledBy } : {}) };
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
        this.publisher.publish(ask.record.sessionId, { kind: 'answer', text, askId, ...(options.handledBy ? { handledBy: options.handledBy } : {}) }),
        ask.outcome.then(() => { throw new RelayError('RELAY_ASK_SETTLED', '提问已结束，答案未继续提交。', 409); })
      ]);
      await this.finish(ask, { status: 'answered', answer: text, askId });
      const result = ask.record;
      if (result.status !== 'answered') throw new RelayError('RELAY_ASK_SETTLED', '提问已结束，答案未继续提交。', 409);
      return result;
    } catch (error) {
      if (this.pending.has(askId) && ask.record.status !== 'pending') await this.finish(ask, { status: 'cancelled', askId, reason: '答案提交失败，请重新提问。' });
      throw error;
    }
  }

  listPending(sessionId?: string): RelayAskRecord[] {
    return [...this.durable.listPending(sessionId), ...[...this.pending.values()].filter(ask => (!sessionId || ask.record.sessionId === sessionId) && ask.record.status === 'pending' && !ask.settlement).map(ask => ({ ...ask.record }))];
  }

  get(askId: string): RelayAskRecord | undefined {
    let record = this.durable.get(askId) ?? this.pending.get(askId)?.record;
    if (!record && this.durableHistory) {
      try {
        record = this.store!.getSync!(askId);
        if (record && record.status !== 'pending' && record.status !== 'answering') this.history.delete(askId);
      } catch (error) {
        if (!this.history.has(askId)) throw error;
      }
    }
    record ??= this.history.get(askId);
    return record ? { ...record } : undefined;
  }

  private cancelRegistration(registration: AskRegistration, reason: string, cancelDurable = false) {
    if (cancelDurable) registration.durableCancellationReason ??= reason;
    registration.reason ??= reason;
    const ask = registration.ask;
    if (ask && (ask.record.status === 'pending' || ask.record.status === 'answering' && !ask.answerPublishStarted)) {
      this.track(this.finish(ask, { status: 'cancelled', askId: ask.record.id, reason }));
    }
  }

  cancelSession(sessionId: string, reason = '会话已结束') {
    this.track(this.durable.cancelSession(sessionId, reason));
    for (const registration of this.registrations) {
      if (registration.sessionId === sessionId) this.cancelRegistration(registration, reason, true);
    }
  }

  close(reason = 'Dutydeck 服务已关闭') {
    this.closed = true;
    this.durable.close();
    for (const registration of this.registrations) if (!registration.ask) registration.reason ??= reason;
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
    await this.durable.flush();
    await Promise.allSettled([...this.writes]);
    const errors = this.writeErrors.splice(0);
    if (errors.length) throw new AggregateError(errors, 'Relay question persistence failed');
  }

  private track(write: Promise<unknown>) {
    this.writes.add(write);
    void write.then(() => this.writes.delete(write), error => { this.writes.delete(write); this.writeErrors.push(error); });
  }

  private finish(ask: PendingAsk, outcome: Exclude<RelayAskOutcome, { status: 'deferred' }>): Promise<void> {
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
    const settle = (committed: RelayAskRecord) => {
      const committedOutcome: RelayAskOutcome = committed.status === 'answered'
        ? { status: 'answered', askId: committed.id, answer: committed.answer! }
        : committed.status === 'expired' ? { status: 'expired', askId: committed.id }
        : { status: 'cancelled', askId: committed.id, reason: committed.reason ?? '提问已结束' };
      ask.record = committed;
      this.pending.delete(committed.id);
      if (!this.durableHistory) this.history.set(committed.id, committed);
      ask.resolve(committedOutcome);
    };
    ask.settlement = (async () => {
      let committed = proposed;
      if (this.store && !await this.store.compareAndSet(previous, proposed)) {
        const authoritative = await this.store.get(previous.id);
        if (!authoritative || authoritative.status === 'pending' || authoritative.status === 'answering') throw new RelayError('RELAY_ASK_CONFLICT', '提问状态未能持久保存，连接已结束，请重新提问。', 409);
        committed = authoritative;
      }
      settle(committed);
    })().catch(async error => {
      if (outcome.status === 'answered' && this.store) {
        const stored = await this.store.get(previous.id).catch(() => undefined);
        // A write may have committed before its acknowledgement failed.
        if (stored && !['pending', 'answering'].includes(stored.status)) { settle(stored); return; }
        const retry: RelayAskRecord = { ...previous, status: 'pending' };
        delete retry.handledBy;
        if (!this.closed && stored?.status === 'answering' && await this.store.compareAndSet(previous, retry).catch(() => false)) {
          // The original waiter has not received an answer. Keep it live after
          // the failed commit and require another explicit human decision.
          ask.record = retry;
          ask.settlement = undefined;
          ask.answerPublishStarted = false;
          clearTimeout(ask.timer);
          ask.timer = setTimeout(() => this.track(this.finish(ask, { status: 'expired', askId: retry.id })), Math.max(0, Date.parse(retry.expiresAt) - Date.now()));
          ask.timer.unref?.();
          const stopped = [...this.registrations].find(registration => registration.ask === ask && registration.reason)?.reason;
          if (this.closed || stopped) await this.finish(ask, { status: 'cancelled', askId: retry.id, reason: stopped ?? 'Dutydeck 服务已关闭' });
          throw error;
        }
      }
      // Other failed terminal writes cannot recreate a waiter.
      if (this.durableHistory) this.history.set(previous.id, previous);
      this.pending.delete(previous.id);
      ask.reject(error);
      throw error;
    });
    return ask.settlement;
  }
}
