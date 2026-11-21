import { expect, it } from 'vitest';
import type { ConfigRepository, SaveLarkConfigInput, StoredLarkConfig } from '@dutydeck/shared';
import { larkBotsConfigKey, publicLarkConfig, readLarkConfigs, saveLarkConfig } from './config.js';

const bot = { appId: 'cli_sample', appSecret: 'sample', riskControlMode: 'off' };
function repository(raw: Record<string, unknown>): ConfigRepository {
  const values = new Map([[larkBotsConfigKey, JSON.stringify([{ ...bot, ...raw }])]]);
  return { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } };
}

// Capture the entire object in each representation, including the difference between
// a missing key and a materialized default. Exclude prompt history (it has a timestamp).
async function roundTrip(raw: Record<string, unknown>, patch: SaveLarkConfigInput) {
  const store = repository(raw);
  const [read] = await readLarkConfigs(store, { readOnly: true });
  const [merged] = await saveLarkConfig(store, undefined, { originalAppId: bot.appId, ...patch });
  const [disk] = JSON.parse((await store.get(larkBotsConfigKey))!);
  const [reread] = await readLarkConfigs(store);
  return { read, public: publicLarkConfig(read), merged, disk, reread, publicAfter: publicLarkConfig(reread) };
}

// Store changes relative to the missing-field case, so every field is checked
// without repeating six nearly identical full configurations in every fixture.
function changes(before: object, after: object) {
  const a = new Map(Object.entries(before));
  const b = new Map(Object.entries(after));
  return Object.fromEntries([...new Set([...a.keys(), ...b.keys()])].filter(key =>
    a.has(key) !== b.has(key) || JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key)))
    .map(key => [key, b.has(key) ? b.get(key) : '<absent>']));
}

it('preserves the stored, published and patched scalar settings through a disk round trip', async () => {
  const empty = await roundTrip({}, {});
  expect(empty.read).toMatchSnapshot('missing stored fields');
  for (const [stage, config] of Object.entries(empty)) expect(changes(empty.read, config)).toMatchSnapshot(stage);
  const boundary = { idleCompactHours: 1, pushIntervalMs: 500, urgentThresholdMs: 60000, pinAfterMs: 1000,
    urgentMaxPerHourPerChat: 1, replyPolishTimeoutMs: 2147483647, traceLimit: 1 };
  const nondefault = {
    ...boundary, groupToolsEnabled: true, groupToolsAllowSend: true, permissionMode: 'ask', defaultAgentId: 'agent',
    fallbackAgentId: 'other', fallbackModel: 'previous', defaultModel: '  raw  ', defaultReasoningEffort: ' high ',
    workspace: '/example', brand: 'lark', p2pMode: 'thread', groupReplyMode: 'shared', mentionPolicy: 'never',
    groupMemoryScope: 'per-group', claudeAutoMemory: 'off', defaultGroupParticipation: 'eager',
    verificationCommand: ' check ', replyPolishAgentId: 'editor', replyPolishModel: 'previous', notifyQuietHours: '22:00-08:00',
    decisionAgentId: ' decide ', memoryModel: ' remember ', replyPolishEnabled: true, welcomeEnabled: false,
    structuredAskCards: false, groupCardMention: false, peerBotsAllowed: false, pinLongTasks: true, showAgentName: true
  };
  const malformed = {
    welcomeEnabled: 0, structuredAskCards: null, groupCardMention: 'true', pinLongTasks: 1, silentProgress: 'true',
    displayName: {}, roleTitle: '', leaderSkill: 0, replyPolishAgentId: false, p2pMode: 'bad', groupReplyMode: '',
    groupMemoryScope: null, claudeAutoMemory: 'bad', executionMode: false, traceLimit: '7',
    idleCompactHours: '2', pushIntervalMs: '20000', replyPolishTimeoutMs: '2000', urgentThresholdMs: '60001',
    pinAfterMs: 999, urgentMaxPerHourPerChat: 1.1, notifyQuietHours: '', preInjectPrompt: 0
  };
  const cases = [
    ['malformed', malformed, {}],
    ['bounds', boundary, { pushIntervalMs: 20000, replyPolishTimeoutMs: 1 }],
    ['outside bounds', { idleCompactHours: 0, pushIntervalMs: 20001, traceLimit: -1, replyPolishTimeoutMs: 2147483648, urgentThresholdMs: 59999 }, {}],
    ['retain', nondefault, {}],
    ['clear', nondefault, { traceLimit: null, replyPolishTimeoutMs: null, urgentThresholdMs: null, pinAfterMs: null,
      urgentMaxPerHourPerChat: null, groupReplyMode: null, verificationCommand: ' ', fallbackAgentId: '', replyPolishEnabled: false,
      replyPolishAgentId: 'new', defaultModel: '', decisionAgentId: '', claudeAutoMemory: 'inherit' }]
  ] as const;
  for (const [label, raw, patch] of cases) {
    const result = await roundTrip(raw, patch);
    const deltas = new Map<string, string[]>();
    for (const stage of Object.keys(empty) as (keyof typeof empty)[]) {
      const delta = JSON.stringify(changes(empty[stage], result[stage]), Object.keys({ ...empty[stage], ...result[stage] }).sort());
      deltas.set(delta, [...deltas.get(delta) ?? [], stage]);
    }
    expect(Object.fromEntries([...deltas].map(([delta, stages]) => [stages.join(', '), JSON.parse(delta)]))).toMatchSnapshot(label);
  }
  const direct = { ...empty.read, ...malformed } as unknown as StoredLarkConfig;
  expect(changes(empty.public, publicLarkConfig(direct))).toMatchSnapshot('direct public projection');
});

it.each([
  ['pushIntervalMs', 499], ['traceLimit', 0], ['replyPolishTimeoutMs', 2147483648], ['urgentThresholdMs', 59999],
  ['pinAfterMs', 999], ['urgentMaxPerHourPerChat', 0], ['idleCompactHours', '2'], ['groupReplyMode', ''],
  ['welcomeEnabled', null], ['botLoopGuard', 1], ['replyPolishAgentId', false]
])('rejects invalid %s without rewriting disk', async (key, value) => {
  const store = repository({});
  const before = await store.get(larkBotsConfigKey);
  await expect(saveLarkConfig(store, undefined, { originalAppId: bot.appId, [key]: value })).rejects.toMatchObject({ code: 'INVALID_LARK_CONFIG' });
  expect(await store.get(larkBotsConfigKey)).toBe(before);
});
