import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from './command.js';
import { TmuxBackend, cleanTmuxSubmissionCapture } from './tmux-backend.js';

vi.mock('./command.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./command.js')>();
  return { ...actual, runCommand: vi.fn() };
});

const mockedRunCommand = vi.mocked(runCommand);
beforeEach(() => { mockedRunCommand.mockReset(); });

const cursor = '\x1b[7m \x1b[0m';

describe('tmux submission cursor capture', () => {
  it('warns once per session when capture fails and still returns no screen proof', async () => {
    mockedRunCommand.mockRejectedValue(new Error('screen unavailable'));
    const warn = vi.fn();
    for (const sessionId of ['ses_capture_warning_1', 'ses_capture_warning_2']) {
      const backend = new TmuxBackend(`tmux-${sessionId}`, { ownerId: `dutydeck:${sessionId}`, log: { warn } });
      await expect(backend.captureInputSubmissionScreen()).resolves.toBeNull();
      await expect(backend.captureInputSubmissionScreen()).resolves.toBeNull();
    }
    expect(warn.mock.calls.map(([data]) => data)).toEqual(['ses_capture_warning_1', 'ses_capture_warning_2'].map(sessionId =>
      expect.objectContaining({ component: 'TmuxBackend', location: 'captureSubmissionScreen', sessionId, error: expect.stringContaining('screen unavailable') })));
  });

  it('removes only the cursor and padding, preserving semantic trailing spaces', () => {
    expect(cleanTmuxSubmissionCapture(`❯ draft${cursor}\n`, '❯ draft   \n──────────\nfooter\n'))
      .toBe('❯ draft\n──────────\nfooter\n');
    expect(cleanTmuxSubmissionCapture(`❯ draft ${cursor}\n`, '❯ draft    \n──────────\nfooter\n'))
      .toBe('❯ draft \n──────────\nfooter\n');
  });

  it('uses the partial logical row count and trims padding on other rows', () => {
    const partial = `a wrapped logical row\nsecond logical row\n❯ next${cursor}\n`;
    const full = 'a wrapped logical row   \nsecond logical row  \n❯ next   \n──────────\nfooter  \n';
    expect(cleanTmuxSubmissionCapture(partial, full))
      .toBe('a wrapped logical row\nsecond logical row\n❯ next\n──────────\nfooter\n');
  });

  it('preserves a non-breaking prompt separator', () => {
    expect(cleanTmuxSubmissionCapture(`❯ draft${cursor}\n`, '❯ draft \n'))
      .toBe('❯ draft\n');
  });

  it('accepts a cursor at the row end without a reset sequence', () => {
    expect(cleanTmuxSubmissionCapture('❯ draft\x1b[7m \n', '❯ draft \n'))
      .toBe('❯ draft\n');
  });

  it.each([
    ['1;7', '27'],
    ['0;7', '0'],
    ['1;0;7', '0;27'],
  ])('accepts reverse video SGR %s with reset SGR %s', (video, reset) => {
    expect(cleanTmuxSubmissionCapture(`❯ draft\x1b[${video}m \x1b[${reset}m\n`, '❯ draft \n'))
      .toBe('❯ draft\n');
  });

  it('still requires reverse video rather than an unrelated SGR cursor-shaped row', () => {
    expect(cleanTmuxSubmissionCapture('❯ draft\x1b[1;27m \x1b[0m\n', '❯ draft \n')).toBeNull();
  });

  it('fails closed without a cursor or when text follows it', () => {
    expect(cleanTmuxSubmissionCapture('❯ draft\n', '❯ draft \n')).toBeNull();
    expect(cleanTmuxSubmissionCapture('startup menu\n', 'startup menu\n', false)).toBe('startup menu\n');
    expect(cleanTmuxSubmissionCapture(`❯ draft${cursor}foreign\n`, '❯ draft foreign\n')).toBeNull();
  });

  it('fails closed when the plain and ANSI cursor rows disagree', () => {
    expect(cleanTmuxSubmissionCapture(`❯ old${cursor}\n`, '❯ new \n')).toBeNull();
  });

  it('uses a visible native cursor in terminal cells and keeps only the typed trailing spaces', () => {
    const row = '❯ 输入  ';
    const full = row + '\n──────────\n? for shortcuts\n';
    const ansi = '\x1b[39m' + row + '\n';
    expect(cleanTmuxSubmissionCapture(ansi, full, true, { column: 7, physicalRow: row })).toBe(full.replace('输入  ', '输入 '));
    expect(cleanTmuxSubmissionCapture('❯ first\n\n', '❯ first\n\n──────────\n', true, { column: 2, physicalRow: '' })).toBe('❯ first\n\n──────────\n');
    expect(cleanTmuxSubmissionCapture(ansi, full, true, { column: 4, physicalRow: row })).toBeNull();
    expect(cleanTmuxSubmissionCapture(ansi, full, true, { column: 9, physicalRow: row })).toBeNull();
    expect(cleanTmuxSubmissionCapture(ansi, full.replace('输入', '消息'), true, { column: 7, physicalRow: row })).toBeNull();
    expect(cleanTmuxSubmissionCapture(ansi, full.replace('──────────', 'more input'), true, { column: 7, physicalRow: row })).toBeNull();
  });

  it('preserves the joined draft when the native cursor is on a wrapped physical row', () => {
    const row = '❯ wrapped input 中文 ';
    expect(cleanTmuxSubmissionCapture(row + '\n', row + '\n──────────\n', true, { column: 4, physicalRow: '中文 ' }))
      .toBe('❯ wrapped input 中文\n──────────\n');
  });

  it('does not downgrade strict input capture when tmux hides the hardware cursor', async () => {
    mockedRunCommand.mockImplementation(async (_command, args) => {
      if (args.includes('#{cursor_y} #{cursor_flag} #{cursor_x}')) return '0 0 7\n';
      const display = args.indexOf('display-message');
      const marker = args[display + 2]!;
      return `❯ draft\n${marker}\n❯ draft \n`;
    });
    const backend = new TmuxBackend('dutydeck-hidden-cursor-test');
    await expect(backend.captureInputSubmissionScreen()).resolves.toBeNull();
    await expect(backend.captureCurrentScreen(true)).resolves.toBe('❯ draft \n');
  });
});
