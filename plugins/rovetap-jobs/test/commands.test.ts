import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSTRUCTION,
  extractMessageText,
  parseJobCommand,
  renderMentionText,
} from '../service/commands.mjs';

describe('parseJobCommand', () => {
  it('uses the default instruction for a bare /job', () => {
    expect(parseJobCommand('/job')).toEqual({
      kind: 'job', alias: 'rovetap', instruction: DEFAULT_INSTRUCTION, explicitTarget: false,
    });
    expect(parseJobCommand('  /job   ')).toMatchObject({ kind: 'job', instruction: DEFAULT_INSTRUCTION });
  });

  it('takes the rest of a bare /job as the instruction (default project)', () => {
    const r = parseJobCommand('/job 复现并修复草稿丢失，补回归测试。');
    expect(r).toMatchObject({ kind: 'job', alias: 'rovetap', explicitTarget: false });
    expect(r.kind === 'job' && r.instruction).toBe('复现并修复草稿丢失，补回归测试。');
  });

  it('accepts an explicit rovetap target, bare or @-mentioned', () => {
    expect(parseJobCommand('/job rovetap 修复草稿丢失')).toMatchObject({
      kind: 'job', alias: 'rovetap', instruction: '修复草稿丢失', explicitTarget: true,
    });
    expect(parseJobCommand('/job RoveTap 修复')).toMatchObject({ kind: 'job', explicitTarget: true, instruction: '修复' });
    expect(parseJobCommand('/job @rovetap 修复')).toMatchObject({ kind: 'job', explicitTarget: true, instruction: '修复' });
    expect(parseJobCommand('/job rovetap')).toMatchObject({ kind: 'job', instruction: DEFAULT_INSTRUCTION });
  });

  it('rejects an @-mentioned project token that is not a configured alias', () => {
    expect(parseJobCommand('/job @other-team do x')).toEqual({ kind: 'unknown-project', token: 'other-team' });
  });

  it('does not treat a bare unknown word as a project (it is instruction text)', () => {
    const r = parseJobCommand('/job whatever project is implied');
    expect(r).toMatchObject({ kind: 'job', explicitTarget: false });
    expect(r.kind === 'job' && r.instruction).toBe('whatever project is implied');
  });

  it('parses after a leading bot mention placeholder or literal name', () => {
    expect(parseJobCommand('@_user_1 /job rovetap hi')).toMatchObject({ kind: 'job', instruction: 'hi' });
    expect(parseJobCommand('@Dutydeck /job hi')).toMatchObject({ kind: 'job', instruction: 'hi' });
    expect(parseJobCommand('  @RoveTapJobs   /job  hi')).toMatchObject({ kind: 'job', instruction: 'hi' });
  });

  it('ignores mention placeholders rendered through metadata', () => {
    const text = renderMentionText('@_user_1 /job rovetap do it', [
      { key: '@_user_1', name: 'Dutydeck', id: { open_id: 'ou_bot' } },
    ], 'ou_bot');
    expect(parseJobCommand(text)).toMatchObject({ kind: 'job', instruction: 'do it' });
  });

  it('renders a non-self mention as a readable @name target', () => {
    const text = renderMentionText('/job @_user_2 fix', [
      { key: '@_user_2', name: 'rovetap', id: { open_id: 'ou_r' } },
    ], 'ou_bot');
    expect(text).toContain('@rovetap');
    expect(parseJobCommand(text)).toMatchObject({ kind: 'job', alias: 'rovetap' });
  });

  it('does not match /jobs or a mid-sentence /job (ordinary messages continue)', () => {
    expect(parseJobCommand('/jobs are not this')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand('hey /job do thing')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand('a /job in the middle')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand('')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand(undefined)).toEqual({ kind: 'not-command' });
  });

  it('accepts additional configured aliases', () => {
    expect(parseJobCommand('/job rt do', { defaultAlias: 'rovetap', aliases: ['rt'] }))
      .toMatchObject({ kind: 'job', alias: 'rovetap' });
  });
});

describe('extractMessageText', () => {
  it('parses text message content JSON', () => {
    expect(extractMessageText('text', JSON.stringify({ text: 'hello' }))).toBe('hello');
  });

  it('extracts title + lines from a post message', () => {
    const content = {
      zh_cn: { title: '标题', content: [[{ tag: 'text', text: '第一行' }], [{ tag: 'a', text: '链接', href: 'https://x' }]] },
    };
    const text = extractMessageText('post', JSON.stringify(content));
    expect(text).toContain('标题');
    expect(text).toContain('第一行');
    expect(text).toContain('链接 (https://x)');
  });

  it('returns empty for unsupported types', () => {
    expect(extractMessageText('image', JSON.stringify({ image_key: 'k' }))).toBe('');
  });
});
