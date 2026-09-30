import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@dutydeck/shared';
import { claudeApiError } from '@dutydeck/pty-driver';
import { renderLarkCardElements, renderLarkResultElements } from './card-renderer.js';
import { buildLarkCard } from './service.js';

const event = (sequence: number, type: AgentEvent['type'], data: unknown): AgentEvent => ({
  id: `evt_${sequence}`, sessionId: 'ses_signals', sequence, type, data, timestamp: new Date(1_725_753_600_000 + sequence * 1_000).toISOString()
});
const answer = (sequence: number) => event(sequence, 'text', { role: 'assistant', text: '结论：已完成。' });
const usage = (sequence: number, used: number, size?: number) => event(sequence, 'status', { state: 'usage', used, ...(size ? { size } : {}) });
const compaction = (sequence: number, phase: 'start' | 'completed' | 'failed') => event(sequence, 'status', { state: 'compaction', phase });
const resultCard = (events: AgentEvent[], state: 'completed' | 'failed' = 'completed') =>
  JSON.stringify(buildLarkCard({ cardKind: 'result', state, taskName: '任务', elements: renderLarkResultElements(events) }));
const hints = (card: string) => card.split('/new --handoff').length - 1;

describe('Claude API errors on the failure card', () => {
  const record = (error: string, text: string, apiErrorStatus?: number) => ({
    type: 'assistant', uuid: `uuid-${error}`, isApiErrorMessage: true, error, ...(apiErrorStatus ? { apiErrorStatus } : {}),
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] }
  });

  it.each([
    ['rate_limit', record('rate_limit', "You've hit your session limit · resets 9:40pm (Asia/Shanghai)", 429), '额度约在 9:40pm (Asia/Shanghai) 重置'],
    ['authentication_failed', record('authentication_failed', 'Please run /login · API Error: 401 OAuth access token has expired.', 401), '重新登录 Claude Code（/login）'],
    ['server_error', record('server_error', 'API Error: 529 Overloaded.', 529), 'Claude Code 已在内部重试过。请稍后重发'],
    ['model_not_found', record('model_not_found', "There's an issue with the selected model (x-model).", 404), '检查 Agent 配置或 /new 的 --model 参数'],
    ['context too long', record('invalid_request', 'Prompt is too long'), '请用 /new 开新会话']
  ])('shows the %s hint and the original line instead of a bare failure', (_name, entry, hint) => {
    const error = claudeApiError(entry)!;
    const card = resultCard([event(1, 'tool_result', { id: 't1', name: 'Bash', status: 'completed', output: 'ok' }), event(2, 'error', error.data)], 'failed');
    expect(card).toContain(hint);
    expect(card).toContain(`原文：${entry.message.content[0]!.text}`);
    expect(card).not.toContain('result_missing');
  });
});

describe('context pressure hint on the result card', () => {
  it('appears once when the last usage reading reaches 80% of the window', () => {
    const card = resultCard([usage(1, 90_000, 200_000), usage(2, 170_000, 200_000), answer(3)]);
    expect(card).toContain('上下文已用 85%，可用 /new --handoff 带交接开新会话。');
    expect(hints(card)).toBe(1);
  });

  it('stays away below the threshold, when only an earlier reading was high, and without any signal', () => {
    expect(hints(resultCard([usage(1, 150_000, 200_000), answer(2)]))).toBe(0);
    expect(hints(resultCard([usage(1, 190_000, 200_000), usage(2, 60_000, 200_000), answer(3)]))).toBe(0);
    expect(hints(resultCard([usage(1, 190_000), answer(2)]))).toBe(0);
    expect(hints(resultCard([answer(1)]))).toBe(0);
  });

  it('reports a compaction once, with a percentage only when the window size is known', () => {
    const withoutSize = resultCard([compaction(1, 'start'), compaction(2, 'completed'), answer(3)]);
    expect(withoutSize).toContain('本轮发生过上下文压缩，可用 /new --handoff 带交接开新会话。');
    expect(hints(withoutSize)).toBe(1);
    expect(resultCard([compaction(1, 'completed'), usage(2, 30_000, 200_000), answer(3)])).toContain('本轮发生过上下文压缩，上下文已用 15%，可用 /new --handoff');
  });

  it('gives the same advice on a card failed by a compaction failure', () => {
    const card = resultCard([compaction(1, 'start'), compaction(2, 'failed'), event(3, 'error', { message: 'Compacting failed: context window exceeded' })], 'failed');
    expect(card).toContain('本轮上下文压缩失败，可用 /new --handoff 带交接开新会话。');
    expect(hints(card)).toBe(1);
  });

  it('is not shown on a card that is still running', () => {
    expect(JSON.stringify(renderLarkCardElements([compaction(1, 'completed'), answer(2)], { traceLimit: 10 }, false))).not.toContain('/new --handoff');
  });
});
