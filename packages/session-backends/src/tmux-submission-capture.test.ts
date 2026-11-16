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

  it('fails closed without a cursor or when text follows it', () => {
    expect(cleanTmuxSubmissionCapture('❯ draft\n', '❯ draft \n')).toBeNull();
    expect(cleanTmuxSubmissionCapture('startup menu\n', 'startup menu\n', false)).toBe('startup menu\n');
    expect(cleanTmuxSubmissionCapture(`❯ draft${cursor}foreign\n`, '❯ draft foreign\n')).toBeNull();
  });

  it('fails closed when the plain and ANSI cursor rows disagree', () => {
    expect(cleanTmuxSubmissionCapture(`❯ old${cursor}\n`, '❯ new \n')).toBeNull();
  });

  it('does not downgrade strict input capture when tmux hides the hardware cursor', async () => {
    mockedRunCommand.mockImplementation(async (_command, args) => {
      if (args.includes('#{cursor_y} #{cursor_flag}')) return '0 0\n';
      const display = args.indexOf('display-message');
      const marker = args[display + 2]!;
      return `❯ draft\n${marker}\n❯ draft \n`;
    });
    const backend = new TmuxBackend('dutydeck-hidden-cursor-test');
    await expect(backend.captureInputSubmissionScreen()).resolves.toBeNull();
    await expect(backend.captureCurrentScreen(true)).resolves.toBe('❯ draft \n');
  });
});
