import { createRepositories } from '@dutydeck/storage';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';

const repositories = createRepositories(process.argv[2]!);
const config = JSON.parse(process.argv[3]!) as StoredLarkConfig;
await repositories.config.set(larkBotsConfigKey, JSON.stringify([config]));
const log = { info() {}, warn() {}, error() {} };
const derived = process.argv[5] ? JSON.parse(process.argv[5]) : undefined;
const service = derived ? { addReaction: async () => { process.kill(process.pid, 'SIGKILL'); return { reactionId: 'unreachable' }; } } : {};
const coordinator = new LarkMessageCoordinator({} as any, service as any, log, Math.random, 'ou_bot',
  undefined, undefined, undefined, undefined, undefined, { store: repositories.config });
await coordinator.receive(JSON.parse(process.argv[4]!), config);
if (derived) {
  // 受理派生身份的 CAS 完成后、首个远程确认/任务派发前崩溃。
  await coordinator.adopt(derived, config);
  process.exit(99);
}
// 模拟进程在接收已返回、setImmediate 路由尚未执行时被杀；不 close，不做任何恢复/落库补救。
process.kill(process.pid, 'SIGKILL');
