import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, AgentDriver } from '@dutydeck/shared';
import { DutydeckRuntime } from '../../src/index.js';

const [database, cwd, markerFile, writer] = process.argv.slice(2);
if (!database || !cwd || !markerFile || !writer) throw new Error('missing fixture arguments');
const agent: AgentConfig = { id: 'crash-fixture', name: 'Crash fixture', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
const driver: AgentDriver = { start: async () => {}, send: async () => {}, interrupt: async () => {}, resume: async () => {}, stop: async () => {} };
const repos = createRepositories(database);
const runtime = new DutydeckRuntime(repos, {
  driverIdleTimeoutMs: 0,
  probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
  driverFactory: () => driver
});
await runtime.initialize([agent]);
const session = await runtime.start({ agentId: agent.id, cwd });
void runtime.runVerification(session.id, { command: `${process.execPath} ${JSON.stringify(writer)} ${JSON.stringify(markerFile)}` });
while (true) {
  const records = await repos.config.list!(`runtime_verification:${session.id}:`);
  if (records.some(item => JSON.parse(item.value).processStage === 'command_started')) break;
  await new Promise(resolve => setTimeout(resolve, 10));
}
process.stdout.write(`READY ${session.id}\n`);
await new Promise(() => {});
