import { describe, expect, it } from 'vitest';
import { larkConclusionHeadline, larkElapsedLabel, larkStoppedAtLabel, larkUserStatus } from './card-status.js';
import { larkCardNeedsYou, larkCardResultMarkdown } from './service.js';

describe('larkUserStatus', () => {
  it('maps internal states to the five user-visible statuses', () => {
    expect(larkUserStatus({ state: 'running' })).toMatchObject({ status: 'running', label: '进行中', template: 'blue', stopped: false });
    expect(larkUserStatus({ state: 'completed', label: '运行完成' })).toMatchObject({ status: 'completed', label: '完成', template: 'green' });
    expect(larkUserStatus({ state: 'failed' })).toMatchObject({ status: 'failed', label: '失败', template: 'red' });
    expect(larkUserStatus({ state: 'interrupted' })).toMatchObject({ status: 'interrupted', label: '中断', template: 'grey' });
    expect(larkUserStatus({ state: 'running', waiting: true })).toMatchObject({ status: 'attention', label: '需要你处理', template: 'orange', reason: '等待审批' });
    expect(larkUserStatus({ state: 'running', waiting: true, awaitingAnswer: true })).toMatchObject({ reason: '等待回答' });
  });

  it('puts the reason in the subtitle and marks recovery and stalled states as stopped', () => {
    expect(larkUserStatus({ state: 'running', label: '排队受阻' })).toMatchObject({ status: 'interrupted', reason: '排队受阻', stopped: true });
    expect(larkUserStatus({ state: 'reconcile_required' })).toMatchObject({ status: 'interrupted', reason: '需要核对', stopped: true });
    expect(larkUserStatus({ state: 'running', label: '可能卡住' })).toMatchObject({ status: 'running', reason: '可能卡住', stopped: true });
    expect(larkUserStatus({ state: 'queued', queuePosition: 2 })).toMatchObject({ status: 'running', reason: '排队第 2' });
  });
});

describe('time labels', () => {
  it('formats durations and switches to hours at 60 minutes', () => {
    expect(larkElapsedLabel(5)).toBe('5 秒');
    expect(larkElapsedLabel(65)).toBe('1 分 5 秒');
    expect(larkElapsedLabel(3540)).toBe('59 分');
    expect(larkElapsedLabel(3600)).toBe('1 小时');
    expect(larkElapsedLabel(3600 + 25 * 60 + 30)).toBe('1 小时 25 分');
  });

  it('writes the stop time in Shanghai time and adds the date across days', () => {
    const now = Date.parse('2026-10-06T10:00:00Z');
    expect(larkStoppedAtLabel('2026-10-06T06:30:00Z', now)).toBe('停在 14:30');
    expect(larkStoppedAtLabel('2026-10-05T06:30:00Z', now)).toBe('停在 10-05 14:30');
    expect(larkStoppedAtLabel('garbage', now)).toBeUndefined();
    expect(larkStoppedAtLabel(undefined, now)).toBeUndefined();
  });
});

describe('larkConclusionHeadline', () => {
  it('takes the first sentence and skips labels, code, tables and need-you lines', () => {
    expect(larkConclusionHeadline('**最终答复**\n\n已修复登录超时。根因是重试没有退避。')).toBe('已修复登录超时');
    expect(larkConclusionHeadline('## 结论\n需要你：确认发布\n\n```\ncode\n```\n**已完成**：升级依赖')).toBe('已完成：升级依赖');
    expect(larkConclusionHeadline('[报告](/tmp/a.md) 已生成')).toBe('报告 已生成');
    expect(larkConclusionHeadline('')).toBeUndefined();
    expect(larkConclusionHeadline(undefined)).toBeUndefined();
  });

  it('truncates long sentences with an ellipsis', () => {
    const headline = larkConclusionHeadline('字'.repeat(200), 40)!;
    expect(Array.from(headline)).toHaveLength(40);
    expect(headline.endsWith('…')).toBe(true);
  });
});

describe('result markdown rewriting', () => {
  it('downgrades local-path links to inline code and keeps web links and code blocks', () => {
    expect(larkCardResultMarkdown('见 [报告](/data/report.md) 和 [文档](https://a.example/x) 与 [相对](docs/a.md)'))
      .toBe('见 `报告` 和 [文档](https://a.example/x) 与 `相对`');
    expect(larkCardResultMarkdown('```\n[x](/a)\n```')).toBe('```\n[x](/a)\n```');
  });

  it('pulls need-you lines out of the body but never empties it', () => {
    expect(larkCardNeedsYou('已完成\n需要你：确认发布时间')).toEqual({ body: '已完成', needs: ['需要你：确认发布时间'] });
    expect(larkCardNeedsYou('需要你：只有这一行')).toEqual({ body: '需要你：只有这一行', needs: [] });
    expect(larkCardNeedsYou('```\n需要你：在代码块里\n```\n正文')).toMatchObject({ needs: [] });
  });
});
