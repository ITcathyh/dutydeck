import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DriverDetachedError, DriverRecoveryError, type AgentConfig } from '@dutydeck/shared';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage';
import { HerdrBackend, herdrControlEnvironment } from '@dutydeck/session-backends';
import { pinnedSessionUuid, type CliAdapter } from '@dutydeck/cli-adapters';
import { buildSessionMarker } from './session-id/index.js';
import { PtyCliDriver } from './driver.js';

describe.skipIf(process.env.DUTYDECK_TEST_HERDR !== 'true')('real Herdr primary turn recovery', () => {
  it('recovers original busy execution and appended transcript once, never resends, restores first prompt and rejects stale ownership', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dd-herdr-recovery-'));
    const sessionId = 'ses_herdr-recovery', name = `dutydeck-${randomBytes(16).toString('hex')}`;
    const binary = execFileSync('/bin/sh', ['-c', 'command -v herdr'], { encoding: 'utf8' }).trim();
    const options = { binary, stateFile: join(cwd, 'identity.json'), ownerId: `dutydeck:${sessionId}`, processProbe: { identify: childProcessIdentity, observe: observeProcess } };
    const project = join(cwd, 'projects', realpathSync(cwd).replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(project, { recursive: true });
    const transcript = join(project, `${pinnedSessionUuid(sessionId)}.jsonl`);
    writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: pinnedSessionUuid(sessionId), message: { role: 'user', content: buildSessionMarker(sessionId) } }) + '\n');
    const prompts: string[] = [], outputs: string[] = [];
    const adapter: CliAdapter = { id: 'claude-code', capabilities: { resume: true }, buildArgs: () => [], injectSessionContext: () => '', buildResumeCommand: () => [], completionPattern: /HERDR-SHELL-DONE/,
      writeInput: async (backend, prompt) => { prompts.push(prompt); (await backend.write(prompt + '\n')); } };
    const agent: AgentConfig = { id: 'fixture', name: 'fixture', command: '/bin/sh', args: ['-c', 'exec /bin/sh'], protocol: 'pty-cli', cwd, env: { CLAUDE_CONFIG_DIR: cwd }, permissionMode: 'full-trust', timeout: 30, capabilities: { pause: false, resume: true }, builtin: false };
    const drivers: PtyCliDriver[] = [];
    const create = () => {
      const backend = new HerdrBackend(name, options);
      const driver = new PtyCliDriver({ agent, adapter, backend, sessionId, onEvent: event => { if (event.type === 'text') outputs.push((event.data as any).text); }, onExit() {} });
      drivers.push(driver); return { driver, backend };
    };
    try {
      const first = create(); await first.driver.start();
      const pid = first.backend.getPid();
      const checkpoint = (await first.driver.checkpoint())!;
      expect(checkpoint).toBeDefined();
      const sent = first.driver.send('sleep 2; echo HERDR-SHELL-DONE').catch(error => error);
      await expect.poll(async () => (await first.backend.getDutydeckMetadata('turn_id'))).toBe(checkpoint.turnId);
      first.driver.prepareForDaemonShutdown(); await first.driver.stop();
      expect(await sent).toBeInstanceOf(DriverDetachedError);
      expect(first.driver.isDetachedForShutdown()).toBe(true);
      expect(await first.driver.isStopped()).toBe(false);
      const bad = create();
      await expect(bad.driver.recover({ ...checkpoint, turnId: 'stale' })).rejects.toBeInstanceOf(DriverRecoveryError);
      await bad.driver.stop(); expect(first.backend.getPid()).toBe(pid);
      const recovered = create(), adopted = vi.fn(async () => {});
      const recovering = recovered.driver.recover(checkpoint, adopted);
      await expect.poll(() => adopted.mock.calls.length).toBe(1);
      expect(recovered.backend.getPid()).toBe(pid);
      appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'HERDR_RECOVERED_RESULT' }] } }) + '\n');
      await recovering;
      expect(prompts).toHaveLength(1);
      expect(outputs.filter(value => value === 'HERDR_RECOVERED_RESULT')).toHaveLength(1);
      expect((await recovered.backend.getDutydeckMetadata('first_prompt_sent'))).toBe('true');
      await recovered.driver.resume();
      expect(recovered.backend.getPid()).toBe(pid);
      await recovered.driver.stop({ discardSession: true });
      expect(await recovered.driver.isStopped()).toBe(true);
      console.log(JSON.stringify({ herdr_driver_recovery: { pid, checkpoint: true, original_busy_turn: true, no_resubmit: true, transcript_once: true, stale_recovery_preserved_pane: true, stop_verified: true } }));
    } finally {
      for (const driver of drivers) { driver.prepareForDaemonShutdown(); await driver.stop(); }
      try { execFileSync(binary, ['session', 'stop', name, '--json'], { env: herdrControlEnvironment(process.env), stdio: 'pipe' }); } catch {}
      try { execFileSync(binary, ['session', 'delete', name, '--json'], { env: herdrControlEnvironment(process.env), stdio: 'pipe' }); } catch {}
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);
});
