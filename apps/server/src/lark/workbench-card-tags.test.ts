import { describe, expect, it } from 'vitest';
import type { WorkItem } from '@dutydeck/shared';
import { workItemElements } from './workbench.js';

const evil = '<at id=all></at><text_tag color="red">x</text_tag>';
const rawTag = /<\s*\/?\s*(?:at|text_tag)\b/iu;

const base = (status: WorkItem['status']): WorkItem => ({
  id: 'work_1', parentSessionId: 'ses_1', title: `标题${evil}`, goal: `目标${evil}`, revision: 1, status,
  plan: {
    title: '计划', outputStepId: 'impl',
    steps: [{ id: 'impl', title: `实现${evil}`, kind: 'agent', agentId: 'worker', instruction: `指令${evil}`, dependsOn: [] }]
  },
  steps: [{ id: 'impl', status: status === 'awaiting_confirmation' ? 'pending' : 'failed',
    attempts: [{ id: 'att_1', number: 1, status: 'failed', createdAt: '', updatedAt: '', error: `错误${evil}` }] }],
  delivery: { status: 'not_requested', attempts: 0 }, createdAt: '', updatedAt: ''
});

const text = (elements: unknown) => JSON.stringify(elements);

describe('workItemElements 中和 Agent 文本里的卡片标签', () => {
  it('待确认计划不输出原样标签', () => {
    expect(text(workItemElements(base('awaiting_confirmation')))).not.toMatch(rawTag);
  });

  it('计划修订、执行步骤和请求不输出原样标签', () => {
    const item = base('failed');
    item.pendingRevision = {
      version: 2, requestedAt: '', source: 'agent', reason: `原因${evil}`, digest: 'd'.repeat(64),
      confirmationReasons: ['需要停止步骤'],
      impact: { keep: [], rerun: ['impl'], stop: [], discard: [], remove: [], add: ['extra'] },
      plan: { ...item.plan, steps: [...item.plan.steps, { id: 'extra', title: `新增${evil}`, kind: 'agent', agentId: 'worker', instruction: `新指令${evil}`, dependsOn: [] }] }
    };
    const output = text(workItemElements(item, [{ stepId: 'impl', requestId: 'r1', taskId: 't1', kind: 'question', text: `提问${evil}` } as never]));
    expect(output).not.toMatch(rawTag);
    expect(output).toContain('＜at id=all>');
  });

  it('目标的错误和最终产出不输出原样标签', () => {
    const item = { ...base('failed'), error: `失败${evil}`, output: { text: `产出${evil}`, digest: 'd', stepId: 'impl' } };
    // 只看会解析标签的 markdown 元素；重试按钮是纯文本。
    const output = text(workItemElements(item).filter(element => (element as { tag?: string }).tag === 'markdown'));
    expect(output).toContain('失败');
    expect(output).toContain('产出');
    expect(output).not.toMatch(rawTag);
  });
});
