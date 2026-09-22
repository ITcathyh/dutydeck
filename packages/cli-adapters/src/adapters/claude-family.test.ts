import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeFamilyAdapter, prepareClaudeFamilyInput } from './claude-family.js';
import type { PtyLike } from '../types.js';

// The observed pane's last four nonempty lines are verbatim; history above is anonymized.
const resumedComposer = readFileSync(new URL('../fixtures/claude-resume-ready/screen.txt', import.meta.url), 'utf8');
const cwd = '/workspace/trusted-project';
const trustScreen = (selected: 'No, exit' | 'Yes, I trust this folder', path = cwd) => [
  '─'.repeat(120), 'Accessing workspace:', '', path, '',
  'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  "project, or work from your team). If not, take a moment to review what's in this folder first.",
  '', "Claude Code'll be able to read, edit, and execute files here.", '', 'Security guide', '',
  selected === 'No, exit' ? '❯ No, exit' : '  No, exit',
  selected === 'Yes, I trust this folder' ? '❯ Yes, I trust this folder' : '  Yes, I trust this folder',
  'Enter to confirm · Esc to cancel',
].join('\n');
const composer = [
  '▐▛███▛█   Claude Code v2.1.267',
  '▝▜██████▀  model_api/experimental_0812[1m] with xhigh effort · API Usage Billing',
  `  ▝▝ ▝▝    ${cwd}`,
  '', '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '❯\u00a0', '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

class TrustBackend implements PtyLike {
  screen: string;
  readonly writes: string[] = [];

  constructor(screen: string) { this.screen = screen; }
  write(data: string): void { this.writes.push(data); }
  readScreen(): string { return this.screen; }
  sendSpecialKeys(...keys: string[]): void {
    this.writes.push(...keys);
    if (keys[0] === 'Down') this.screen = trustScreen('Yes, I trust this folder');
    if (keys[0] === 'Enter') this.screen = composer;
  }
}

describe('Claude family startup trust confirmation', () => {
  it('only enables screen-driven startup confirmation for Claude Code', () => {
    expect(createClaudeFamilyAdapter('claude-code').prepareInput).toBe(prepareClaudeFamilyInput);
    expect(createClaudeFamilyAdapter('seed').prepareInput).toBeUndefined();
    expect(createClaudeFamilyAdapter('relay').prepareInput).toBeUndefined();
  });

  it('full-trust changes No to Yes, confirms it, then waits for the composer', async () => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(trustScreen('No, exit'));
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' });
      await vi.advanceTimersByTimeAsync(300);
      expect(backend.writes).toEqual(['Down', 'Enter']);
      await preparing;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not move selection when Yes is already selected', async () => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(trustScreen('Yes, I trust this folder'));
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' });
      await vi.advanceTimersByTimeAsync(200);
      await preparing;
      expect(backend.writes).toEqual(['Enter']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries discarded startup keys only while the exact trust page remains selected', async () => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(trustScreen('No, exit'));
      let downCount = 0;
      let enterCount = 0;
      backend.sendSpecialKeys = (...keys: string[]) => {
        backend.writes.push(...keys);
        if (keys[0] === 'Down' && ++downCount === 2) backend.screen = trustScreen('Yes, I trust this folder');
        if (keys[0] === 'Enter' && ++enterCount === 2) backend.screen = composer;
      };
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' });
      await vi.advanceTimersByTimeAsync(2_200);
      await preparing;
      expect(backend.writes).toEqual(['Down', 'Down', 'Enter', 'Enter']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ask does not approve the trust dialog or submit any input', async () => {
    const backend = new TrustBackend(trustScreen('No, exit'));
    await expect(prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'ask' }))
      .rejects.toThrow('请通过终端确认目录');
    expect(backend.writes).toEqual([]);
  });

  it.each(['ask', undefined] as const)('accepts an already trusted composer with permission mode %s', async permissionMode => {
    const backend = new TrustBackend(composer.replace(/⏵⏵[^\n]*/g, '? for shortcuts'));
    await prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode });
    expect(backend.writes).toEqual([]);
  });

  it.each([resumedComposer, `❯ old request\nPrevious answer\n${resumedComposer}`])('accepts the captured resumed composer without a scrolled-away banner and writes no keys', async screen => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(screen);
      let ready = false;
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' }).then(() => { ready = true; });
      // Consume only in case the old predicate reaches its timeout after this assertion fails.
      void preparing.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(ready).toBe(true);
      await preparing;
      expect(backend.writes).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('requires a screen reader instead of blindly submitting', async () => {
    await expect(prepareClaudeFamilyInput({ write: () => {} }, { sessionId: 'sid', cwd, permissionMode: 'full-trust' }))
      .rejects.toThrow('screen reader');
  });

  it('does not carry a prior trust observation into a different dialog', async () => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(trustScreen('No, exit'));
      backend.sendSpecialKeys = (...keys: string[]) => {
        backend.writes.push(...keys);
        backend.screen = `${trustScreen('No, exit')}\n${trustScreen('Yes, I trust this folder', '/other-project')}`;
      };
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' });
      const assertion = expect(preparing).rejects.toThrow('启动尚未就绪');
      await vi.advanceTimersByTimeAsync(30_100);
      await assertion;
      expect(backend.writes).toEqual(['Down']);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['partial trust page', trustScreen('No, exit').replace('Enter to confirm · Esc to cancel', '')],
    ['unknown setup prompt', 'Unknown setup\n────────\n❯\n────────'],
    ['truncated resumed footer', resumedComposer.trimEnd().split('\n').slice(0, -1).join('\n')],
    ['unknown resumed footer', resumedComposer.replace(/⏵⏵[^\n]*/, 'Press Enter to continue')],
    ['unfinished composer', resumedComposer.replace('\n❯\n', '\n❯ unfinished input\n')],
    ['historical empty prompt alongside composer', `❯\n${resumedComposer}`],
    ['quoted historical composer followed by output', `${resumedComposer}More response text`],
    ['permission choice above stale composer', `Permission required\n❯ 1. Yes\n  2. No\n${resumedComposer}`],
    ['choice menu above stale composer', `Select an option\n❯ Continue\n${resumedComposer}`],
    ['trust dialog above stale composer', `${trustScreen('No, exit')}\n${resumedComposer}`],
  ])('does not treat a %s as ready or write any key', async (_name, screen) => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(screen);
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' });
      const assertion = expect(preparing).rejects.toThrow('启动尚未就绪');
      await vi.advanceTimersByTimeAsync(30_100);
      await assertion;
      expect(backend.writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
