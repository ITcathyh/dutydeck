import assert from 'node:assert/strict';
import { createRepositories } from '@dutydeck/storage';
import { LarkGroupParticipation } from './group-participation.js';

const failure = process.argv[2];
const repos = createRepositories(':memory:');
const scope = { appId: 'app', chatId: 'chat' };
let calls = 0, warnings = 0, broken = true;
const store = { ...repos.config, get: async (key: string) => { if (broken) throw new Error('audit unavailable'); return repos.config.get(key); } };
const p = new LarkGroupParticipation({ repository: repos.collaboration, inboxStore: store, debounceMs: 5, readConfig: async () => ({ listening: true }), authorize: async () => true,
  serviceFor: () => ({}), decider: {}, log: { warn: () => warnings++ } } as any) as any;
p.decide = async () => { calls++; if (calls === 1 && failure === 'audit') throw new Error('decision failed'); };
const drain = p.drain.bind(p);
let first = true;
if (failure === 'timer') p.drain = async (...args: unknown[]) => { if (first) { first = false; throw new Error('unexpected drain rejection'); } return drain(...args); };
p.enqueue(scope, { event: { messageId: 'first' } });
await new Promise(resolve => setTimeout(resolve, 40));
broken = false;
p.enqueue(scope, { event: { messageId: 'next' } });
await new Promise(resolve => setTimeout(resolve, 40));
await p.close();
repos.close();
assert.equal(calls, failure === 'audit' ? 2 : 1);
assert.ok(warnings > 0);
console.log('survived-next-message', calls);
