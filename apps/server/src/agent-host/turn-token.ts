import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ConfigRepository } from '@dutydeck/shared';

export const groupToolsSigningSecretConfigKey = 'lark.group_tools.signing_secret';

export class AgentGroupToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AgentGroupToolError';
  }

  response() {
    return { error: { ...this.details, code: this.code, message: this.message } };
  }
}

export class TurnTokens {
  constructor(protected readonly signingSecret = randomBytes(32).toString('base64url')) {}

  finalTurnToken(sessionId: string, taskId: string, attemptId: string) {
    return createHmac('sha256', this.signingSecret).update(`dutydeck-final-turn-v1\0${sessionId}\0${taskId}\0${attemptId}`).digest('base64url');
  }

  private matchesTurn(sessionId: string, taskId: string, attemptId: string, presented?: string) {
    const expected = Buffer.from(this.finalTurnToken(sessionId, taskId, attemptId));
    const actual = Buffer.from(typeof presented === 'string' ? presented : '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  assertFinalTurn(sessionId: string, taskId: string, attemptId: string, presented?: string) {
    if (!this.matchesTurn(sessionId, taskId, attemptId, presented)) throw new AgentGroupToolError('FINAL_TURN_EXPIRED', '最终答复凭证不属于当前任务轮次，请使用本轮提供的命令。', 403);
  }

  workbenchTurnToken(sessionId: string, taskId: string, attemptId: string) {
    return this.finalTurnToken(sessionId, taskId, attemptId);
  }

  assertWorkbenchTurn(sessionId: string, taskId: string, attemptId: string | undefined, presented?: string) {
    if (!attemptId || !this.matchesTurn(sessionId, taskId, attemptId, presented)) throw new AgentGroupToolError('WORK_ITEM_TURN_EXPIRED', '工具凭证不属于当前任务尝试，请使用本轮提供的完整 agent --turn 命令前缀。', 403);
  }
}

export async function loadOrCreateGroupToolsSigningSecret(configs: ConfigRepository) {
  const existing = (await configs.get(groupToolsSigningSecretConfigKey))?.trim();
  if (existing) return existing;
  const created = randomBytes(32).toString('base64url');
  await configs.set(groupToolsSigningSecretConfigKey, created);
  return created;
}
