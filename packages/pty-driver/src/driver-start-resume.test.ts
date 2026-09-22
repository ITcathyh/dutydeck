import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '@dutydeck/shared';
import { createClaudeCodeAdapter } from '@dutydeck/cli-adapters';
import { TmuxBackend } from '@dutydeck/session-backends';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage';
import { PtyCliDriver } from './driver.js';
import { claudeProjectDir } from './cli-paths.js';
import { buildSessionMarker, resolveCliSessionId } from './session-id/index.js';

const roots: string[] = [];
const savedTmuxDirectory = process.env.TMUX_TMPDIR;
beforeEach(() => { const dir = mkdtempSync(join(tmpdir(), 'dd-start-tmux-')); roots.push(dir); process.env.TMUX_TMPDIR = dir; });
afterEach(() => { if (savedTmuxDirectory === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = savedTmuxDirectory; });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sessionId = 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const nativeId = sessionId.slice(4);

describe('start reconnects durable native history only with session evidence', () => {
  it.each(['matching', 'old-matching', 'new', 'foreign', 'filename-only', 'grok-directory'] as const)('%s history selects complete resume or fresh argv without guessing', async kind => {
    const cwd = mkdtempSync(join(tmpdir(), 'dd-start-resume-')); roots.push(cwd);
    const configDir = join(cwd, 'private-config');
    const env = { CLAUDE_CONFIG_DIR: configDir, GROK_HOME: join(cwd, 'grok'), FIXTURE_ENV: 'kept' };
    const project = claudeProjectDir(cwd, env); mkdirSync(project, { recursive: true });
    if (kind !== 'new') writeFileSync(join(project, `${nativeId}.jsonl`), JSON.stringify({
      type: 'user', sessionId: nativeId,
      message: { role: 'user', content: kind === 'matching' || kind === 'old-matching' ? buildSessionMarker(sessionId)
        : kind === 'foreign' ? buildSessionMarker('ses_other-session') : 'unrelated transcript' },
    }) + '\n');
    if (kind === 'old-matching') {
      utimesSync(join(project, `${nativeId}.jsonl`), new Date(0), new Date(0));
      for (let i = 0; i < 45; i++) writeFileSync(join(project, `newer-${i}.jsonl`), JSON.stringify({
        type: 'user', sessionId: `other-${i}`, message: { role: 'user', content: buildSessionMarker(`ses_other-${i}`) },
      }) + '\n');
    }
    const output = join(cwd, 'argv.json'); const fixture = join(cwd, 'cli.mjs');
    writeFileSync(fixture, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify({argv:process.argv.slice(2),env:process.env.FIXTURE_ENV})); setInterval(()=>{},1000);`);
    let adapter = createClaudeCodeAdapter();
    if (kind === 'grok-directory') {
      mkdirSync(join(env.GROK_HOME, 'sessions', encodeURIComponent(cwd), sessionId), { recursive: true });
      expect(resolveCliSessionId('grok', { sessionId, cwd, env, requireMarker: true })).toBe(sessionId);
      adapter = { ...adapter, id: 'grok' };
    }
    const fresh = kind === 'new' || kind === 'grok-directory';
    const prompts: string[] = [];
    adapter.prepareInput = undefined;
    adapter.writeInput = (_backend, prompt) => { prompts.push(prompt); };
    const agent = { id: 'fixture', name: 'fixture', command: process.execPath, args: [fixture, '--wrapper', 'kept'], protocol: 'pty-cli',
      cwd, env, model: 'fixture-model', permissionMode: 'full-trust', timeout: 60,
      capabilities: { pause: false, resume: true }, builtin: false } as AgentConfig;
    const driver = new PtyCliDriver({ agent, adapter, sessionId, backend: new TmuxBackend(`start-${kind}`, { ownerId: `dutydeck:${sessionId}` }), processProbe: { identify: childProcessIdentity, observe: observeProcess }, onEvent() {}, onExit() {} });
    try {
      if (kind === 'foreign' || kind === 'filename-only') {
        await expect(driver.start()).rejects.toThrow('refusing to reuse its id');
        expect(existsSync(output)).toBe(false);
        expect(TmuxBackend.probeSession(`start-${kind}`)).toBe('missing');
        return;
      }
      await driver.start();
      let launched: { argv: string[]; env: string } | undefined;
      for (let tries = 0; tries < 100; tries++) {
        try { launched = JSON.parse(readFileSync(output, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      expect(launched?.env).toBe('kept');
      const argv = launched!.argv;
      expect(argv.slice(0, 2)).toEqual(['--wrapper', 'kept']);
      expect(argv).toContain('--model'); expect(argv).toContain('fixture-model');
      expect(argv).toContain('--dangerously-skip-permissions');
      expect(argv.includes('--resume')).toBe(!fresh);
      expect(argv.includes('--session-id')).toBe(fresh);
      if (!fresh) expect(argv[argv.indexOf('--resume') + 1]).toBe(nativeId);
      const turn = driver.send('next request').catch(() => {});
      for (let tries = 0; !prompts.length && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.includes(buildSessionMarker(sessionId))).toBe(fresh);
      await driver.stop(); await turn;
    } finally { await driver.stop(); }
  });
});
