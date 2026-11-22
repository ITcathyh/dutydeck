import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentConfigSchema } from '@dutydeck/shared';
import { expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from './index.js';

it('requires an explicit provider registry before starting a runtime', () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  try {
    expect(() => new DutydeckRuntime(repos, { cleanupIntervalMs: 0 })).toThrowError(
      expect.objectContaining({ code: 'RUNTIME_DRIVER_PROVIDERS_REQUIRED' })
    );
  } finally { repos.close(); }
});

it('uses the registered resource protocol, backend and advertised operations', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-provider-'));
  const received: string[] = [];
  const runtime = new DutydeckRuntime(repos, {
    cleanupIntervalMs: 0,
    terminalBackend: async () => 'herdr',
    providers: [{
      protocol: 'jsonl', resourceProtocol: 'local',
      probe: () => ({ protocol: 'jsonl', available: true, pause: false, resume: true }),
      capabilities: () => ({ permissionPosture: true, persistentTerminal: true, operations: ['isStopped'] }),
      create({ session, agent, onEvent }) {
        expect(session.terminalBackend).toBe('herdr');
        expect(agent.env.dutydeck_terminal_backend).toBeUndefined();
        return {
          async start() {}, async resume() {}, async stop() {}, async interrupt() {}, isStopped: async () => true,
          async setModel() { throw new Error('Undeclared operation called'); },
          async send(prompt) {
            expect(typeof prompt).toBe('string');
            received.push(String(prompt));
            onEvent({ type: 'text', data: { text: 'reply' } });
            onEvent({ type: 'completed', data: { stopReason: 'end_turn' } });
          },
        };
      },
    }],
  });
  try {
    await runtime.initialize([agentConfigSchema.parse({ id: 'registered', name: 'Registered', protocol: 'jsonl',
      command: process.execPath, cwd, permissionMode: 'ask' })]);
    const session = await runtime.start({ agentId: 'registered' });
    const task = await runtime.send(session.id, 'one');
    expect(task.status).toBe('completed');
    expect(received).toEqual(['one']);
    expect(repos.execution.getResources(session.id).some(resource => resource.kind === 'local_only')).toBe(true);
    await expect(runtime.setModel(session.id, 'two')).rejects.toMatchObject({ code: 'MODEL_SWITCH_UNSUPPORTED' });
  } finally { await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); }
});
