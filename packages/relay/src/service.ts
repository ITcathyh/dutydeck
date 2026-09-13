import { RelayError, type RelayAskChoice, type RelayEventPublisher } from './types.js';
import { RelayAskBroker, type RelayAskOutcome } from './ask-broker.js';
import { RelayCapabilityRegistry, relayBearerToken } from './capability.js';

/** 单条回传消息的长度上限，防止一次 send 把事件流灌爆 */
export const relayMessageMaxLength = 32_000;

export interface RelaySendInput { text?: string }
export interface RelayAskInput { question?: string; timeoutMs?: number; choices?: RelayAskChoice[]; multiple?: boolean }
export interface RelayAnswerInput { answer?: string }

function requireText(value: string | undefined, code: string, label: string) {
  const text = value?.trim();
  if (!text) throw new RelayError(code, `${label}不能为空。`, 400);
  if (text.length > relayMessageMaxLength) {
    throw new RelayError(code, `${label}超过 ${relayMessageMaxLength} 字符上限。`, 413);
  }
  return text;
}

/**
 * 回传通道服务层。路由层只负责取 token / 解 body，语义全在这里，
 * 便于不经 HTTP 直接单测。
 */
export class RelayService {
  constructor(
    private readonly capabilities: RelayCapabilityRegistry,
    private readonly publisher: RelayEventPublisher,
    private readonly broker: RelayAskBroker
  ) {}

  /** 非阻塞推送：消息进事件流，立刻返回 */
  async send(authorization: string | undefined, sessionId: string | undefined, input: RelaySendInput) {
    const capability = await this.capabilities.resolve(relayBearerToken(authorization), sessionId);
    const text = requireText(input.text, 'RELAY_MESSAGE_REQUIRED', '回传内容');
    await this.publisher.publish(capability.sessionId, { kind: 'send', text });
    return { ok: true as const, sessionId: capability.sessionId, delivered: true as const };
  }

  /** 阻塞提问：Promise 直到被回答/超时/取消才 resolve（HTTP 响应因此被扣住） */
  async ask(authorization: string | undefined, sessionId: string | undefined, input: RelayAskInput): Promise<RelayAskOutcome> {
    const capability = await this.capabilities.resolve(relayBearerToken(authorization), sessionId);
    const question = requireText(input.question, 'RELAY_QUESTION_REQUIRED', '提问内容');
    return this.broker.register({
      sessionId: capability.sessionId, question, timeoutMs: input.timeoutMs,
      // 不能用 truthy：choices:null 必须进 broker 的校验抛 400，而不是被静默当成普通提问登记。
      ...(input.choices !== undefined ? { choices: input.choices } : {}),
      ...(input.multiple === true ? { multiple: true } : {})
    });
  }

  /** 从 token 反解会话 id，供路由在注册终态唤醒时使用 */
  resolveSession(authorization: string | undefined, sessionId?: string) {
    return this.capabilities.resolve(relayBearerToken(authorization), sessionId);
  }

  /**
   * 用户回答。**不需要会话 token**——回答来自 Web/IM 侧的人类用户，
   * 走的是 app.ts 的常规访问认证（远程访问要 access token，loopback 豁免），
   * 与「CLI 子进程持会话凭证」是两套身份，不要混用。
   */
  answer(sessionId: string, askId: string, input: RelayAnswerInput) {
    const answer = requireText(input.answer, 'RELAY_ANSWER_REQUIRED', '回答内容');
    return this.broker.answer(askId, answer, { sessionId });
  }

  listPending(sessionId: string) {
    return { asks: this.broker.listPending(sessionId) };
  }
}
