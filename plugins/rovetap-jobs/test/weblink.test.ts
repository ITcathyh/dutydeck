import { describe, expect, it } from 'vitest';
import { buildTaskUrl } from '../service/weblink.mjs';
import { replyText } from '../service/messages.mjs';

// Operators can mistakenly paste a one-time pairing/login URL as webBaseUrl.
// These tests pin the receipt boundary: origin + path + trusted task/leader
// only; credentials and pairing secrets must never reach Feishu.

describe('buildTaskUrl trusted boundary', () => {
  it('keeps origin and base path and sets only task/leader query', () => {
    expect(buildTaskUrl('https://rove.example.com/workbench/', 'pt_1', 'pl_1'))
      .toBe('https://rove.example.com/workbench/?task=pt_1&leader=pl_1');
  });

  it('drops pre-existing query and fragment from a fake pairing URL', () => {
    const pairing = 'https://rove.example.com/join?pairing_token=SECRET_TOKEN_123#token=SECRET_FRAG_456';
    const url = buildTaskUrl(pairing, 'pt_1', 'pl_1');
    expect(url).toBe('https://rove.example.com/join?task=pt_1&leader=pl_1');
    expect(url).not.toContain('SECRET_TOKEN_123');
    expect(url).not.toContain('SECRET_FRAG_456');
    expect(url).not.toContain('pairing_token');
  });

  it('rejects userinfo instead of forwarding credentials', () => {
    expect(() => buildTaskUrl('https://operator:p4ssw0rd@rove.example.com/', 'pt_1', 'pl_1'))
      .toThrow(/userinfo/);
    expect(() => buildTaskUrl('https://operator@rove.example.com/', 'pt_1', 'pl_1'))
      .toThrow(/userinfo/);
  });

  it('keeps the HTTPS requirement and the loopback HTTP exception', () => {
    expect(() => buildTaskUrl('http://rove.example.com/', 'pt_1', 'pl_1')).toThrow(/https/);
    expect(buildTaskUrl('http://127.0.0.1:3000/workbench', 'pt_1', 'pl_1'))
      .toBe('http://127.0.0.1:3000/workbench?task=pt_1&leader=pl_1');
  });

  it('returns null without the base or both ids', () => {
    expect(buildTaskUrl('', 'pt_1', 'pl_1')).toBeNull();
    expect(buildTaskUrl('https://rove.example.com', '', 'pl_1')).toBeNull();
    expect(buildTaskUrl('https://rove.example.com', 'pt_1', '')).toBeNull();
  });

  it('rejects a malformed base URL', () => {
    expect(() => buildTaskUrl('not a url', 'pt_1', 'pl_1')).toThrow(/合法绝对 URL/);
  });
});

describe('rovetap job receipts', () => {
  const job = { pairfob: { taskId: 'pt_1', leaderId: 'pl_1' } } as any;

  it('accepted receipt cleans query and fragment from a fake pairing URL', () => {
    const config = {
      webBaseUrl: 'https://rove.example.com/join?pairing_token=SECRET_TOKEN_123#token=SECRET_FRAG_456',
    } as any;
    const text = replyText('accepted', job, config);
    expect(text).toContain('https://rove.example.com/join?task=pt_1&leader=pl_1');
    expect(text).not.toContain('SECRET_TOKEN_123');
    expect(text).not.toContain('SECRET_FRAG_456');
    expect(text).not.toContain('pairing_token');
  });

  it('phase receipt carries the same clean link', () => {
    const config = {
      webBaseUrl: 'https://rove.example.com?pairing_token=SECRET_TOKEN_123#f=SECRET_FRAG_456',
    } as any;
    const text = replyText('phase:done', job, config);
    expect(text).toContain('项目任务入口（仅在已连接总机的 RoveTap 环境可用）');
    expect(text).toContain('https://rove.example.com/?task=pt_1&leader=pl_1');
    expect(text).not.toContain('SECRET_TOKEN_123');
    expect(text).not.toContain('SECRET_FRAG_456');
  });

  it('accepted receipt omits the link when the base carries userinfo', () => {
    const config = { webBaseUrl: 'https://operator:p4ssw0rd@rove.example.com/workbench' } as any;
    const text = replyText('accepted', job, config);
    expect(text).toContain('已接单');
    expect(text).not.toContain('p4ssw0rd');
    expect(text).not.toContain('operator');
    expect(text).not.toContain('http');
  });

  it.each([
    ['排查搜索\u2028修复草稿', '排查搜索\u2028修复草稿', '排查搜索'],
    ['\u0085\u2029\t 找回草稿\u0085核对发布 ', '找回草稿\u0085核对发布', '找回草稿'],
    ['核对草稿\n\r\t补测试\u2029再复测', '核对草稿 补测试\u2029再复测', '核对草稿 补测试'],
    ['\u0085 \u2028\t \u2029', '外部项目委托', '外部项目委托'],
    ['🧪'.repeat(201), '🧪'.repeat(200), '🧪'.repeat(60)],
    [`\ufeff${' '.repeat(197)}\u2028甲乙`, `\ufeff${' '.repeat(197)}\u2028甲`, '甲'],
    [`${'甲'.repeat(58)}ΟΣΑ`, `${'甲'.repeat(58)}ΟΣΑ`, `${'甲'.repeat(58)}Ο`],
    [`${'甲'.repeat(58)}ΟΣ\u2028Α`, `${'甲'.repeat(58)}ΟΣ\u2028Α`, `${'甲'.repeat(58)}ΟΣ`],
    ['ΟΣ', 'ΟΣ', 'Ο'],
  ])('keeps the searchable fragment within the actual RoveTap title for %j', (instruction, upstreamTitle, expected) => {
    const text = replyText('accepted', { ...job, instruction }, {});
    const fragment = text.match(/^标题片段：([^\n]*)/m)?.[1] ?? '';

    expect(fragment).toBe(expected);
    expect(upstreamTitle).toContain(fragment);
    for (const cardText of [upstreamTitle, `A${upstreamTitle}`, `${upstreamTitle}A`, `A${upstreamTitle}A`]) {
      expect(cardText.toLocaleLowerCase()).toContain(fragment.toLocaleLowerCase());
    }
    expect(fragment).not.toMatch(/[\n\r\u0085\u2028\u2029]/u);
    expect([...fragment].length).toBeLessThanOrEqual(60);
    expect(text).toContain('任务号：pt_1');
    expect(text).not.toMatch(/https?:\/\//);
  });
});
