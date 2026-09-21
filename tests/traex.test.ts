import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { listAcpxBuiltinAgents, normalizeAcpxEvent, renderAgentCommand } from '@dutydeck/acp-client';

let cwd: string;
beforeAll(async () => { cwd = await mkdtemp(join(tmpdir(), 'dutydeck-traex-')); });
afterAll(async () => rm(cwd, { recursive: true, force: true }));

const traeAgent = (directory = cwd) => ({ id: 'trae', name: 'Trae', command: 'traecli', args: ['acp', 'serve'], protocol: 'acp' as const, cwd: directory, env: {}, permissionMode: 'ask' as const, timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });

describe('Trae through ACPX registry acceptance', () => {
  it('1. is present in the ACPX built-in registry', () => expect(listAcpxBuiltinAgents().find(agent => agent.id === 'trae')).toEqual({ id: 'trae', argv: ['traecli', 'acp', 'serve'] }));
  it('2-5. starts the configured ACP process, initializes, creates a session, and sends a prompt', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const trae = { ...traeAgent(cwd), command: process.execPath, args: [fixture], timeout: 10 };
    const runtime = new DutydeckRuntime(repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }) });
    try {
      await runtime.initialize([trae]);
      const session = await runtime.start({ agentId: 'trae', cwd }); await runtime.send(session.id, 'Trae prompt');
      expect((await runtime.getEvents(session.id)).some(e => e.type === 'text' && (e.data as any).text.includes('Trae prompt'))).toBe(true);
      await runtime.stop(session.id);
    } finally {
      await runtime.shutdown();
      repos.close();
    }
  });
  it('6. converts TraeX text into the unified event', () => expect(normalizeAcpxEvent({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hello' } } } })?.type).toBe('text'));
  it('11. passes model, cwd, and env through configuration', () => { const trae = { ...traeAgent('/configured/cwd'), model: 'm', env: { TOKEN: 'x' } }; expect(trae).toMatchObject({ cwd: '/configured/cwd', model: 'm', env: { TOKEN: 'x' } }); expect(renderAgentCommand(trae)).toContain("'traecli'"); });
  it('12. reports an explicit dependency error when the CLI disappears', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const runtime = new DutydeckRuntime(repos, { probe: () => ({ protocol: 'acp', available: false, detail: 'CLI unavailable', pause: false, resume: true }) });
    try {
      await runtime.initialize([traeAgent(cwd)]);
      await expect(runtime.start({ agentId: 'trae' })).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' });
    } finally {
      await runtime.shutdown();
      repos.close();
    }
  });
});
