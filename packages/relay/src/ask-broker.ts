import { randomUUID } from 'node:crypto';
import {
  RelayError,
  type RelayAskRecord,
  type RelayAskStatus,
  type RelayEventPublisher
} from './types.js';

export const relayAskDefaultTimeoutMs = 300_000;
export const relayAskMinTimeoutMs = 1_000;
export const relayAskMaxTimeoutMs = 3_600_000;

/** 提问被唤醒的结果。exit code 契约见 packages/relay/src/cli-contract.ts */
export type RelayAskOutcome =
  | { status: 'answered'; answer: string; askId: string }
  | { status: 'expired'; askId: string }
  | { status: 'cancelled'; askId: string; reason: string };

interface PendingAsk {
  id: string;
  sessionId: string;
  question: string;
  createdAt: string;
  expiresAt: string;
  timer: NodeJS.Timeout;
  waiters: Array<(outcome: RelayAskOutcome) => void>;
  settled: boolean;
}

const nowIso = () => new Date().toISOString();

/**
 * 阻塞式提问的服务端。
 *
 * 阻塞实现：**HTTP 长轮询**——`POST /api/relay/ask` 的响应被扣住不发，
 * 直到有人回答 / 超时 / 会话结束。CLI 侧因此是一次普通的 fetch，
 * 不需要轮询文件、不需要 WS 客户端，任何语言的 CLI 都能用 curl 复现。
 * （对齐 botmux ask broker 的形态：那边同样是 daemon 扣住 HTTP 响应。）
 *
 * ⚠️ 每条唤醒路径都必须 settle，否则子进程永久卡死。目前四条：
 *   1. answer()          —— 用户回答
 *   2. 超时定时器         —— expired
 *   3. cancelSession()   —— 会话结束/停止
 *   4. close()           —— daemon 关停（对齐 botmux 的 invalidateAll）
 */
export class RelayAskBroker {
  private readonly pending = new Map<string, PendingAsk>();
  /** 已终结的提问，保留投影供 UI/测试查询（不含 waiter） */
  private readonly history = new Map<string, RelayAskRecord>();

  constructor(private readonly publisher: RelayEventPublisher) {}

  /** 注册一个提问并返回一个「被回答/超时/取消才 resolve」的 Promise */
  async register(input: { sessionId: string; question: string; timeoutMs?: number }): Promise<RelayAskOutcome> {
    const question = input.question.trim();
    if (!question) throw new RelayError('RELAY_QUESTION_REQUIRED', '提问内容不能为空。', 400);
    const timeoutMs = input.timeoutMs ?? relayAskDefaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < relayAskMinTimeoutMs || timeoutMs > relayAskMaxTimeoutMs) {
      throw new RelayError(
        'RELAY_INVALID_TIMEOUT',
        `超时必须是 ${relayAskMinTimeoutMs}-${relayAskMaxTimeoutMs} 之间的整数毫秒。`,
        400
      );
    }

    const id = `ask_${randomUUID()}`;
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();

    // 先把问题投进事件流：用户要先看得见问题，才可能回答。
    // 失败则不注册，直接抛错——否则子进程会阻塞在一个没人看得见的问题上。
    await this.publisher.publish(input.sessionId, { kind: 'ask', text: question, askId: id });

    return new Promise<RelayAskOutcome>(resolve => {
      const timer = setTimeout(() => this.settle(id, { status: 'expired', askId: id }), timeoutMs);
      // 不让待回答的提问吊住进程退出
      timer.unref?.();
      this.pending.set(id, {
        id,
        sessionId: input.sessionId,
        question,
        createdAt,
        expiresAt,
        timer,
        waiters: [resolve],
        settled: false
      });
    });
  }

  /** 用户回答。返回被唤醒的记录；提问不存在/已终结时抛错。 */
  async answer(askId: string, answer: string, options: { sessionId?: string } = {}): Promise<RelayAskRecord> {
    const ask = this.pending.get(askId);
    if (!ask) {
      const historical = this.history.get(askId);
      if (historical) throw new RelayError('RELAY_ASK_SETTLED', `提问已经结束（${historical.status}），无法再回答。`, 409);
      throw new RelayError('RELAY_ASK_NOT_FOUND', `未知的提问：${askId}`, 404);
    }
    // 会话隔离：带了 sessionId 就必须对得上，避免 A 会话回答 B 会话的提问
    if (options.sessionId && options.sessionId !== ask.sessionId) {
      throw new RelayError('RELAY_ASK_NOT_FOUND', `未知的提问：${askId}`, 404);
    }
    const text = answer.trim();
    if (!text) throw new RelayError('RELAY_ANSWER_REQUIRED', '回答内容不能为空。', 400);

    // 回答同样进事件流，用户在时间线里能看到自己答了什么
    await this.publisher.publish(ask.sessionId, { kind: 'answer', text, askId });
    this.settle(askId, { status: 'answered', answer: text, askId });
    return this.history.get(askId)!;
  }

  /** 会话结束：唤醒该会话所有阻塞中的提问，避免子进程永久卡死 */
  cancelSession(sessionId: string, reason = '会话已结束') {
    for (const ask of [...this.pending.values()]) {
      if (ask.sessionId === sessionId) this.settle(ask.id, { status: 'cancelled', askId: ask.id, reason });
    }
  }

  /** daemon 关停：唤醒所有阻塞中的提问 */
  close(reason = 'Dockmux 服务已关闭') {
    for (const ask of [...this.pending.values()]) {
      this.settle(ask.id, { status: 'cancelled', askId: ask.id, reason });
    }
  }

  listPending(sessionId?: string): RelayAskRecord[] {
    return [...this.pending.values()]
      .filter(ask => !sessionId || ask.sessionId === sessionId)
      .map(ask => this.project(ask, 'pending'));
  }

  get(askId: string): RelayAskRecord | undefined {
    const ask = this.pending.get(askId);
    return ask ? this.project(ask, 'pending') : this.history.get(askId);
  }

  private project(ask: PendingAsk, status: RelayAskStatus, extra: Partial<RelayAskRecord> = {}): RelayAskRecord {
    return {
      id: ask.id,
      sessionId: ask.sessionId,
      question: ask.question,
      status,
      createdAt: ask.createdAt,
      expiresAt: ask.expiresAt,
      ...extra
    };
  }

  private settle(askId: string, outcome: RelayAskOutcome) {
    const ask = this.pending.get(askId);
    if (!ask || ask.settled) return;
    ask.settled = true;
    clearTimeout(ask.timer);
    this.pending.delete(askId);
    this.history.set(
      askId,
      this.project(
        ask,
        outcome.status,
        outcome.status === 'answered'
          ? { answer: outcome.answer }
          : outcome.status === 'cancelled'
            ? { reason: outcome.reason }
            : {}
      )
    );
    const waiters = ask.waiters;
    ask.waiters = [];
    for (const waiter of waiters) {
      try { waiter(outcome); } catch { /* 单个等待者异常不影响其它人被唤醒 */ }
    }
  }
}
