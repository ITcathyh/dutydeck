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

describe('receipts do not leak pairing-url segments', () => {
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
});
