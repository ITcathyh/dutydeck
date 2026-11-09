import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '@dutydeck/shared';
import { createClaudeCodeAdapter } from '@dutydeck/cli-adapters';
import { TmuxBackend } from '@dutydeck/session-backends';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage/helpers';
import { PtyCliDriver } from './driver.js';
import { claudeProjectDir } from './cli-paths.js';
import { buildSessionMarker } from './session-id/index.js';

// claudeAutoMemory=off 的终端回归：真实 tmux 重新拉起已有会话时，子进程收到变量，且仍用原生会话 id 续接。
const roots: string[] = [];
const savedTmuxDirectory = process.env.TMUX_TMPDIR;
beforeEach(() => { const dir = mkdtempSync(join(tmpdir(), 'dd-auto-memory-tmux-')); roots.push(dir); process.env.TMUX_TMPDIR = dir; });
afterEach(() => { if (savedTmuxDirectory === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = savedTmuxDirectory; });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sessionId = 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const nativeId = sessionId.slice(4);

describe('Claude auto memory marker on terminal relaunch', () => {
  it.each([
    ['off', { dutydeck_claude_auto_memory: 'off' }, '1'],
    ['off with an explicit Agent value', { dutydeck_claude_auto_memory: 'off', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }, '0'],
    ['unmarked', {}, null],
  ] as const)('%s: resumes the same native session and passes the expected variable', async (name, marker, expected) => {
    const cwd = mkdtempSync(join(tmpdir(), 'dd-auto-memory-')); roots.push(cwd);
    const env: Record<string, string> = { CLAUDE_CONFIG_DIR: join(cwd, 'private-config'), ...marker };
    const project = claudeProjectDir(cwd, env); mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${nativeId}.jsonl`), JSON.stringify({ type: 'user', sessionId: nativeId, message: { role: 'user', content: buildSessionMarker(sessionId) } }) + '\n');
    const output = join(cwd, 'launch.json'); const fixture = join(cwd, 'cli.mjs');
    writeFileSync(fixture, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify({argv:process.argv.slice(2),autoMemory:process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null})); setInterval(()=>{},1000);`);
    const adapter = createClaudeCodeAdapter();
    const agent = { id: 'fixture', name: 'fixture', command: process.execPath, args: [fixture], protocol: 'pty-cli', cwd, env,
      permissionMode: 'full-trust', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false } as AgentConfig;
    const backendName = `auto-memory-${name.replace(/\W+/g, '-')}`;
    const driver = new PtyCliDriver({ agent, adapter, sessionId, backend: new TmuxBackend(backendName, { ownerId: `dutydeck:${sessionId}` }), processProbe: { identify: childProcessIdentity, observe: observeProcess }, onEvent() {}, onExit() {} });
    try {
      await driver.start();
      let launched: { argv: string[]; autoMemory: string | null } | undefined;
      for (let tries = 0; !launched && tries < 200; tries++) {
        try { launched = JSON.parse(readFileSync(output, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      expect(launched?.argv[launched.argv.indexOf('--resume') + 1]).toBe(nativeId);
      expect(launched?.argv).not.toContain('--session-id');
      expect(launched?.autoMemory).toBe(expected);
    } finally { await driver.stop(); }
  });
});
