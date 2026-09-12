import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeAdapter } from '../../cli-adapters/src/adapters/claude-code.js';
import type { CliAdapter } from '../../cli-adapters/src/types.js';
import type { AgentConfig, NormalizedDriverEvent } from '@dutydeck/shared';
import { PtyBackend, type SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

const TRUST_CLI = String.raw`
let trusted = false;
let input = '';
let selected = 'no';
let downCount = 0;
let enterCount = 0;
process.stdin.setRawMode?.(true);
function show(selected) {
  globalThis.selected = selected;
  process.stdout.write('\x1b[2J\x1b[H────────────────────────────────────────────────────────────────────────────────\nAccessing workspace:\n\n /workspace/dutydeck\n\nQuick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source\nproject, or work from your team). If not, take a moment to review what\'s in this folder first.\n\nClaude Code\'ll be able to read, edit, and execute files here.\n\nSecurity guide\n');
  process.stdout.write(selected === 'no' ? '❯ No, exit\n  Yes, I trust this folder\n' : '  No, exit\n❯ Yes, I trust this folder\n');
  process.stdout.write('Enter to confirm · Esc to cancel\n');
}
show('no');
process.stdin.on('data', chunk => {
  input += chunk;
  if (!trusted) {
    if (input.includes('\x1b[200~')) process.stdout.write('EARLY_PROMPT\n');
    if (input.includes('\x1b[B')) {
      input = input.replace('\x1b[B', '');
      if (++downCount === 2) show('yes');
    }
    if (input.includes('\r') && globalThis.selected === 'yes') {
      input = input.replace('\r', '');
      if (++enterCount === 2) {
        trusted = true;
        process.stdout.write('\x1b[2J\x1b[HClaude Code v2.1.267\n/workspace/dutydeck\n────────────────\n❯ \n────────────────\n⏵⏵ bypass permissions on\n');
      }
    } else if (input.includes('\r')) {
      input = input.replace('\r', '');
      process.stdout.write('EARLY_CONFIRM\n');
    }
    return;
  }
  const end = input.indexOf('\x1b[201~');
  if (end >= 0) {
    const prompt = input.slice(input.indexOf('\x1b[200~') + 6, end);
    input = input.slice(end + 6);
    process.stdout.write('RECEIVED:' + prompt + '\n✳ Worked for 1s\n❯ \n');
  }
});
`;

function waitFor(description: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const began = Date.now();
    const timer = setInterval(() => {
      if (condition()) { clearInterval(timer); resolve(); }
      else if (Date.now() - began > timeoutMs) { clearInterval(timer); reject(new Error(`Timed out: ${description}`)); }
    }, 25);
  });
}

function strictTrustPage(path: string): string {
  return [
    '─'.repeat(120), 'Accessing workspace:', '', path, '',
    'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
    "project, or work from your team). If not, take a moment to review what's in this folder first.",
    '', "Claude Code'll be able to read, edit, and execute files here.", '', 'Security guide', '',
    '❯ No, exit', '  Yes, I trust this folder', 'Enter to confirm · Esc to cancel',
  ].join('\n');
}

describe('PtyCliDriver Claude startup preparation', () => {
  let dir: string;
  let fixture: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dutydeck-claude-trust-'));
    fixture = join(dir, 'trust-cli.mjs');
    await writeFile(fixture, TRUST_CLI.replaceAll('/workspace/dutydeck', dir), 'utf8');
  });

  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('confirms the observed workspace trust page before writing the first prompt', async () => {
    const events: NormalizedDriverEvent[] = [];
    const driver = new PtyCliDriver({
      agent: agentConfig(fixture, dir),
      adapter: {
        ...createClaudeCodeAdapter(),
        buildArgs: () => [fixture],
        writeInput: (backend, prompt) => backend.write(`\x1b[200~${prompt}\x1b[201~`),
      },
      backend: new PtyBackend(),
      onEvent: event => events.push(event),
      onExit: () => {},
      sessionId: 'claude-startup-session',
    });
    try {
      await driver.start();
      await waitFor('trust screen render', () => events.some(event => String(event.data?.text ?? '').includes('Accessing workspace:')));
      await driver.send('TASK_AFTER_TRUST');
      await waitFor('received task', () => events.some(event => String(event.data?.text ?? '').includes('RECEIVED:')));
      const screen = events.filter(event => event.type === 'raw_terminal').at(-1)?.data?.text ?? '';
      expect(String(screen)).toContain('TASK_AFTER_TRUST');
      expect(events.some(event => String(event.data?.text ?? '').includes('EARLY_PROMPT'))).toBe(false);
      expect(events.some(event => String(event.data?.text ?? '').includes('EARLY_CONFIRM'))).toBe(false);
    } finally {
      await driver.stop();
    }
  }, 20_000);

  it('rejects a send stopped during preparation and never invokes writeInput', async () => {
    let writes = 0;
    let releasePreparation: (() => void) | undefined;
    const adapter: CliAdapter = {
      id: 'preparing-cli', capabilities: {}, buildArgs: () => [fixture],
      prepareInput: () => new Promise(resolve => { releasePreparation = resolve; }),
      writeInput: () => { writes++; },
    };
    const driver = new PtyCliDriver({
      agent: agentConfig(fixture, dir), adapter, backend: new PtyBackend(), onEvent: () => {}, onExit: () => {}, sessionId: 'stop-preparing',
    });
    await driver.start();
    const sending = driver.send('must not be written');
    await waitFor('prepare invoked', () => releasePreparation !== undefined);
    await driver.stop();
    await expect(sending).rejects.toThrow('Driver stopped');
    releasePreparation?.();
    expect(writes).toBe(0);
  });

  it('rejects a send interrupted during preparation and never invokes writeInput', async () => {
    let writes = 0;
    let interrupts = 0;
    let releasePreparation: (() => void) | undefined;
    let onData: (data: string) => void = () => {};
    const backend: SessionBackend = {
      kind: 'pty', sessionName: undefined, spawn() {},
      write() { writes++; onData('DONE'); return true; },
      resize() {}, interrupt() { interrupts++; }, kill() {},
      onData(callback) { onData = callback; }, onExit() {},
    };
    const adapter: CliAdapter = {
      id: 'preparing-cli', capabilities: {}, buildArgs: () => [],
      completionPattern: /DONE/,
      prepareInput: () => new Promise(resolve => { releasePreparation = resolve; }),
      writeInput: target => { target.write('prompt'); },
    };
    const driver = new PtyCliDriver({
      agent: agentConfig(fixture, dir), adapter, backend, onEvent: () => {}, onExit: () => {}, sessionId: 'interrupt-preparing',
    });
    await driver.start();
    const sending = driver.send('must not be written');
    await waitFor('prepare invoked', () => releasePreparation !== undefined);
    await driver.interrupt();
    releasePreparation?.();
    await expect(sending).rejects.toThrow('Driver interrupted');
    expect(interrupts).toBe(1);
    expect(writes).toBe(0);
    await driver.stop();
  });

  it('stops a real Claude trust preparation before its retry can write a prompt', async () => {
    const writes: string[] = [];
    let inputWrites = 0;
    const backend: SessionBackend = {
      kind: 'pty', sessionName: undefined, spawn() {}, write(data) { writes.push(data); return true; }, resize() {}, interrupt() {}, kill() {},
      onData() {}, onExit() {}, captureCurrentScreen: () => strictTrustPage(dir),
    };
    const driver = new PtyCliDriver({
      agent: agentConfig(fixture, dir),
      adapter: { ...createClaudeCodeAdapter(), buildArgs: () => [], writeInput() { inputWrites++; } }, backend,
      onEvent: () => {}, onExit: () => {}, sessionId: 'stop-real-claude-preparing',
    });
    await driver.start();
    const sending = driver.send('must not reach the composer');
    await waitFor('first trust Down', () => writes.length === 1);
    expect(writes).toEqual(['\x1b[B']);
    await driver.stop();
    await expect(sending).rejects.toThrow('Driver stopped');
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(writes).toEqual(['\x1b[B']);
    expect(inputWrites).toBe(0);
  }, 10_000);
});

function agentConfig(fixture: string, home: string): AgentConfig {
  return {
    id: 'claude-startup-fixture', name: 'Claude startup fixture', command: process.execPath, args: [], protocol: 'pty-cli',
    env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude-config') }, cwd: home,
    permissionMode: 'full-trust', timeout: 600, capabilities: { pause: false, resume: false }, builtin: false,
  };
}
