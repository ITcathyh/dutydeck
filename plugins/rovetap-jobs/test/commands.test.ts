import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSTRUCTION,
  extractMessageText,
  isForwardedMessage,
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

  it('accepts a leading mention only when event metadata authenticates it as self', () => {
    const trusted = renderMentionText('@_user_1 /job rovetap do it', [
      { key: '@_user_1', name: 'Dutydeck', id: { open_id: 'ou_bot' } },
    ], 'ou_bot');
    expect(parseJobCommand(trusted)).toMatchObject({ kind: 'job', instruction: 'do it' });

    // Extra whitespace around the stripped mention is harmless.
    const padded = renderMentionText('  @_user_1   /job  hi', [
      { key: '@_user_1', name: 'Dutydeck', id: { open_id: 'ou_bot' } },
    ], 'ou_bot');
    expect(parseJobCommand(padded)).toMatchObject({ kind: 'job', instruction: 'hi' });
  });

  it('rejects a leading @ of another person or bot, even with event metadata', () => {
    const other = renderMentionText('@_user_1 /job do it', [
      { key: '@_user_1', name: '张三', id: { open_id: 'ou_zhang' } },
    ], 'ou_bot');
    expect(other).toContain('@张三');
    expect(parseJobCommand(other)).toEqual({ kind: 'not-command' });

    // Self mention later cannot rescue a different leading addressee.
    const mixed = renderMentionText('@_user_1 @_user_2 /job do it', [
      { key: '@_user_1', name: '张三', id: { open_id: 'ou_zhang' } },
      { key: '@_user_2', name: 'Dutydeck', id: { open_id: 'ou_bot' } },
    ], 'ou_bot');
    expect(parseJobCommand(mixed)).toEqual({ kind: 'not-command' });
  });

  it('never strips text that merely looks like a mention (forged surface text)', () => {
    // Direct parsing has no trusted metadata and must not skip any @token.
    expect(parseJobCommand('@_user_1 /job rovetap hi')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand('@Dutydeck /job hi')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand('  @RoveTapJobs   /job  hi')).toEqual({ kind: 'not-command' });

    // A placeholder absent from the event mentions stays verbatim.
    const forged = renderMentionText('@_user_9 /job x', [
      { key: '@_user_1', name: 'Dutydeck', id: { open_id: 'ou_bot' } },
    ], 'ou_bot');
    expect(forged).toContain('@_user_9');
    expect(parseJobCommand(forged)).toEqual({ kind: 'not-command' });

    // Without a configured selfOpenId even real mentions are not stripped.
    const noIdentity = renderMentionText('@_user_1 /job x', [
      { key: '@_user_1', name: 'Dutydeck', id: { open_id: 'ou_bot' } },
    ], '');
    expect(noIdentity).toContain('@Dutydeck');
    expect(parseJobCommand(noIdentity)).toEqual({ kind: 'not-command' });
  });

  it('renders a non-self mention as a readable @name target', () => {
    const text = renderMentionText('/job @_user_2 fix', [
      { key: '@_user_2', name: 'rovetap', id: { open_id: 'ou_r' } },
    ], 'ou_bot');
    expect(text).toContain('@rovetap');
    expect(parseJobCommand(text)).toMatchObject({ kind: 'job', alias: 'rovetap' });
  });

  it('does not match /jobs, /job/foo or a mid-sentence /job (exact boundary)', () => {
    expect(parseJobCommand('/jobs are not this')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand('/jobx')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand('/job/foo')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand('/job,fix')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand('job please retry the build')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand('hey /job do thing')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand('a /job in the middle')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand('')).toEqual({ kind: 'not-command' });
    expect(parseJobCommand(undefined)).toEqual({ kind: 'not-command' });
  });

  it('accepts any whitespace or end-of-text as the /job delimiter', () => {
    expect(parseJobCommand('/job')).toMatchObject({ kind: 'job' });
    expect(parseJobCommand('/job   ')).toMatchObject({ kind: 'job', instruction: DEFAULT_INSTRUCTION });
    expect(parseJobCommand('/job\tfix draft\t')).toMatchObject({ kind: 'job', instruction: 'fix draft' });
    expect(parseJobCommand('/job　修复全角空格')).toMatchObject({ kind: 'job', instruction: '修复全角空格' });
    expect(parseJobCommand('/job\nfix on next line'))
      .toMatchObject({ kind: 'job', instruction: 'fix on next line' });
  });

  it('keeps ordinary English instructions verbatim with the default project', () => {
    const r = parseJobCommand('/job please reproduce and fix the draft bug, then add a regression test.');
    expect(r).toMatchObject({ kind: 'job', alias: 'rovetap', explicitTarget: false });
    expect(r.kind === 'job' && r.instruction)
      .toBe('please reproduce and fix the draft bug, then add a regression test.');
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

describe('isForwardedMessage', () => {
  it('flags explicit forward provenance descriptors', () => {
    expect(isForwardedMessage({ forward: true })).toBe(true);
    expect(isForwardedMessage({ forward: { sender_id: 'ou_x' } })).toBe(true);
    expect(isForwardedMessage({ forward_from: 'om_old' })).toBe(true);
    expect(isForwardedMessage({ origin: { message_id: 'om_old' } })).toBe(true);
  });

  it('does not flag an ordinary typed text message', () => {
    expect(isForwardedMessage({ message_type: 'text', content: '{"text":"/job"}' })).toBe(false);
    expect(isForwardedMessage(null)).toBe(false);
    expect(isForwardedMessage(undefined)).toBe(false);
  });
});
