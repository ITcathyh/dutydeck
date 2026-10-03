import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import { PtyCliDriver } from '@dutydeck/pty-driver';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig } from '@dutydeck/shared';
import type { SessionBackend } from '@dutydeck/session-backends';
import { renderLarkResultElements } from './card-renderer.js';
import { buildLarkCard } from './service.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('settles the real Claude native authentication rejection as failed and shows its reason on the result card', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dd-native-auth-card-'));
  const project = join(cwd, 'projects', realpathSync(cwd).replace(/[^A-Za-z0-9-]/g, '-')); mkdirSync(project, { recursive: true });
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    driverIdleTimeoutMs: 0,
    probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
    ptyDriverFactory: (agent, _protocol, onEvent, onExit, sessionId) => {
      let stopped = false;
      const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() { stopped = true; }, onData() {}, onExit() {}, interrupt() {} };
      const adapter = createCliAdapter('claude-code');
      const driver = new PtyCliDriver({ agent, adapter: { ...adapter, prepareInput: undefined, writeInput(_backend, prompt) {
        const records = [
          { type: 'user', uuid: 'native-input', isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: `\n\n<pasted_content id="3cff">\n${prompt}\n</pasted_content id="3cff">\n` } },
          { type: 'attachment', uuid: 'native-attachment', parentUuid: 'native-input', isSidechain: false },
          { type: 'assistant', uuid: 'native-error', parentUuid: 'native-attachment', isSidechain: false, isApiErrorMessage: true, error: 'authentication_failed',
            message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } },
        ];
        writeFileSync(join(project, `${pinnedSessionUuid(sessionId!)}.jsonl`), records.map(record => JSON.stringify(record) + '\n').join(''));
      } }, backend, sessionId: sessionId!, onEvent, onExit });
      vi.spyOn(driver, 'isStopped').mockImplementation(async () => stopped);
      return driver;
    },
  });
  cleanup.push(async () => { await runtime.shutdown(); repos.close(); rmSync(cwd, { recursive: true, force: true }); });
  const agent: AgentConfig = { id: 'claude-code', name: 'Claude Code', command: 'unused', args: [], protocol: 'pty-cli', cwd, env: { CLAUDE_CONFIG_DIR: cwd }, permissionMode: 'full-trust', timeout: 0, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id, cwd, permissionMode: 'full-trust' });
  const sending = runtime.send(session.id, 'sanitized incident input'); void sending.catch(() => {});
  await vi.waitFor(async () => expect((await runtime.getTasks(session.id))[0]?.status).toBe('failed'), { timeout: 3_000 });
  const task = await sending;
  expect(task.status).toBe('failed');
  const execution = repos.execution.getTaskExecution(task.id)!;
  expect(execution.currentAttempt?.state).toBe('settled');
  expect(execution.currentAttempt?.outcome).toBe('failed');
  expect(execution.currentAttempt?.reconcileReason).toBeUndefined();
  const events = await runtime.getEvents(session.id);
  expect(events.filter(event => ['error', 'completed'].includes(event.type)).map(event => event.type)).toEqual(['error', 'completed']);
  expect(events.filter(event => event.type === 'status' && event.data.state === 'input_receipt').map(event => event.data.phase)).toEqual(['pending', 'confirmed']);
  const card = JSON.stringify(buildLarkCard({ cardKind: 'result', state: 'failed', taskName: '任务', elements: renderLarkResultElements(events) }));
  expect(card).toContain('重新登录 Claude Code（/login）');
  expect(card).toContain('原文：Not logged in · Please run /login');
  expect(card).not.toContain('需要核对'); expect(card).not.toContain('result_missing');
});
