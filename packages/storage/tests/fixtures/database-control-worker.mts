import { createRepositories } from '../../src/index.js';
import { openDatabaseControl } from '../../src/database-control.js';
import { DutydeckRuntime } from '../../../agent-runtime/src/index.js';
import type { AgentConfig, RepositoryBundle } from '@dutydeck/shared';

let repos: RepositoryBundle | undefined;
let runtime: DutydeckRuntime | undefined;
let maintenance: ReturnType<typeof openDatabaseControl> | undefined;
let markSent!: () => void;
const sent = new Promise<void>(resolve => { markSent = resolve; });
let releaseSend: (() => void) | undefined;
const agent: AgentConfig = { id: 'control-test', name: 'Control test', command: 'unused', args: [], protocol: 'acp', cwd: process.argv[3], env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
process.on('message', async (message: { id: number; action: string; path?: string; mode?: 'runtime' | 'management'; port?: string }) => {
  try {
    let value: unknown = true;
    const path = message.path ?? process.argv[2]!;
    if (message.action === 'open') repos = createRepositories(path, { mode: message.mode, newDatabaseAuthority: 'ledger_v1' });
    if (message.action === 'maintenance') { maintenance = openDatabaseControl(path, {}); maintenance.beginUpgrade(); }
    if (message.action === 'initialize' || message.action === 'start' || message.action === 'verification') {
      runtime ??= new DutydeckRuntime(repos!, { driverIdleTimeoutMs: 0, probe: () => ({ available: true, protocol: 'acp', pause: false, resume: true }), driverFactory: () => ({ start: async () => {}, stop: async () => { releaseSend?.(); }, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true, send: async () => { markSent(); process.send?.({ event: 'sending' }); await new Promise<void>(resolve => { releaseSend = resolve; }); } }) });
      await runtime.initialize([agent]);
      if (message.action === 'verification') {
        const session = await runtime.start({ agentId: agent.id });
        void runtime.runVerification(session.id, { command: `${process.execPath} -e "setInterval(()=>{},1000)"` }).catch(() => {});
        value = session.id;
      }
      if (message.action === 'start') {
        const session = await runtime.start({ agentId: agent.id });
        void runtime.send(session.id, 'active A').catch(() => {});
        await sent;
        value = session.id;
      }
    }
    if (message.action === 'service') {
      const { startLocalServer } = await import('../../../../apps/server/src/service.js');
      const service = await startLocalServer({ env: { ...process.env, HOME: process.argv[3]!, DUTYDECK_DEFAULT_CWD: process.argv[3]!, DUTYDECK_DATABASE_URL: path, DUTYDECK_PORT: message.port ?? '0', DUTYDECK_HOST: '127.0.0.1', DUTYDECK_AGENTS_JSON: '[]', DUTYDECK_DISABLE_LARK_LISTENER: 'true' }, webRoot: process.argv[3] });
      await service.close();
    }
    if (message.action === 'inspect') value = { sessions: await repos!.sessions.list(), config: await repos!.config.list?.(''), tasks: await repos!.tasks.listBySession((await repos!.sessions.list())[0]!.id) };
    if (message.action === 'close') { await runtime?.shutdown(); repos?.close(); maintenance?.close(); process.send?.({ id: message.id, value }); process.disconnect(); return; }
    process.send?.({ id: message.id, value });
  } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
});
process.send?.({ event: 'ready' });
