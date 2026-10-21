import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDecisionGate, scenarioRecordOf } from '@dutydeck/shared';
import { createRepositories, legacyAlarmBinding } from './index.js';
import { migrations, runMigrations, withMigrationTransaction } from './migrations.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function databasePath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scenario-legacy-'));
  directories.push(directory);
  return join(directory, `${name}.sqlite`);
}

/** 用当前的迁移造一个只到指定版本的旧库。 */
function createDatabaseAt(path: string, version: number): void {
  const db = new Database(path);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  withMigrationTransaction(db, () => {
    for (const migration of migrations.filter(item => item.version <= version)) {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(migration.version, '2026-10-14T00:00:00.000Z');
    }
  });
  db.close();
}

const dutyColumns = (db: Database.Database) => (db.pragma('table_info(collaboration_duties)') as Array<{ name: string }>).map(column => column.name);
const insertDuty = (db: Database.Database, chatId: string, alarmJson: string | null, extra: { responder?: string; scenarios?: string } = {}) => db.prepare(`
  INSERT INTO collaboration_duties (app_id, chat_id, revision, responder_json, ${extra.scenarios !== undefined ? 'scenarios_json, ' : ''}alarm_json, updated_by, updated_at)
  VALUES (?, ?, 2, ?, ${extra.scenarios !== undefined ? '?, ' : ''}?, 'ou_admin', '2026-10-14T00:00:00.000Z')
`).run('cli_bot', chatId, extra.responder ?? null, ...(extra.scenarios !== undefined ? [extra.scenarios] : []), alarmJson);
const dutyRow = (db: Database.Database, chatId: string) => db.prepare('SELECT alarm_json, scenarios_json FROM collaboration_duties WHERE app_id = ? AND chat_id = ?').get('cli_bot', chatId) as { alarm_json: string | null; scenarios_json: string | null };

const subscription = { enabled: true, sources: [{ appId: 'cli_alarm', name: '监控' }], levels: ['P0', 'P1'], dedupeHours: 12, maxPerHour: 5, requesterId: 'ou_admin' };
const binding = { enabled: true, params: { sources: [{ appId: 'cli_alarm', name: '监控' }], levels: ['P0', 'P1'], dedupeHours: 12, maxPerHour: 5 }, requesterId: 'ou_admin', packVersion: '1.0.0' };
const faq = { enabled: true, params: { docsTopK: 3 }, requesterId: 'ou_admin', packVersion: '0.1.0' };

describe('legacyAlarmBinding', () => {
  it('按旧订阅格式校验后转成告警包 1.0.0 的绑定，没有确认人时不写 requesterId', () => {
    expect(legacyAlarmBinding(subscription)).toEqual(binding);
    const { requesterId: _omit, ...withoutRequester } = subscription;
    expect(legacyAlarmBinding({ ...withoutRequester, sources: [{ appId: ' cli_alarm ' }], levels: [] }))
      .toEqual({ enabled: true, params: { sources: [{ appId: 'cli_alarm' }], levels: [], dedupeHours: 12, maxPerHour: 5 }, packVersion: '1.0.0' });
  });

  it('不符合旧格式时返回 undefined', () => {
    for (const value of [undefined, null, 'x', { ...subscription, dedupeHours: 0 }, { ...subscription, maxPerHour: 31 }, { ...subscription, extra: 1 }, { ...subscription, levels: [''] }, { ...subscription, sources: [{ appId: '' }] }]) {
      expect(legacyAlarmBinding(value)).toBeUndefined();
    }
  });
});

describe('v38 collaboration_scenarios', () => {
  it('新库全量迁移只加一次 scenarios_json；再次打开不再迁移', async () => {
    const path = await databasePath('fresh');
    createRepositories(path).close();
    const db = new Database(path);
    const columns = dutyColumns(db);
    expect(columns.filter(name => name === 'scenarios_json')).toHaveLength(1);
    expect(columns).toContain('alarm_json');
    const applied = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();
    expect(applied.at(-1)).toMatchObject({ version: 40 });
    db.close();

    createRepositories(path).close();
    const reopened = new Database(path);
    expect(reopened.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all()).toEqual(applied);
    expect(dutyColumns(reopened)).toEqual(columns);
    runMigrations(reopened);
    expect(dutyColumns(reopened)).toEqual(columns);
    reopened.close();
  });

  it('v36 旧库：合法的旧订阅转进 scenarios_json.alarm 并清空 alarm_json，非法的原样保留并记日志', async () => {
    const path = await databasePath('v36');
    createDatabaseAt(path, 36);
    const invalid = JSON.stringify({ ...subscription, dedupeHours: 0 });
    const old = new Database(path);
    expect(dutyColumns(old)).not.toContain('scenarios_json');
    insertDuty(old, 'oc_valid', JSON.stringify(subscription));
    const { requesterId: _omit, ...withoutRequester } = subscription;
    insertDuty(old, 'oc_no_requester', JSON.stringify(withoutRequester), { responder: JSON.stringify({ appId: 'cli_bot', since: '2026-10-14T00:00:00.000Z' }) });
    insertDuty(old, 'oc_invalid', invalid);
    insertDuty(old, 'oc_responder_only', null, { responder: JSON.stringify({ appId: 'cli_bot', since: '2026-10-14T00:00:00.000Z' }) });
    old.close();

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const repos = createRepositories(path);
    const logs = stderr.mock.calls.map(call => String(call[0])).filter(line => line.includes('v38'));
    stderr.mockRestore();
    try {
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('oc_invalid');
      const scope = (chatId: string) => ({ appId: 'cli_bot', chatId });
      expect(await repos.collaboration.getDuty(scope('oc_valid'))).toEqual({ scope: scope('oc_valid'), revision: 2, scenarios: { alarm: binding }, updatedAt: '2026-10-14T00:00:00.000Z' });
      expect(await repos.collaboration.getDuty(scope('oc_no_requester'))).toMatchObject({ responder: { appId: 'cli_bot' }, scenarios: { alarm: { enabled: true, params: binding.params, packVersion: '1.0.0' } } });
      expect((await repos.collaboration.getDuty(scope('oc_no_requester'))).scenarios!.alarm).not.toHaveProperty('requesterId');
      expect(await repos.collaboration.getDuty(scope('oc_invalid'))).toEqual({ scope: scope('oc_invalid'), revision: 2, updatedAt: '2026-10-14T00:00:00.000Z' });
      expect(await repos.collaboration.getDuty(scope('oc_responder_only'))).not.toHaveProperty('scenarios');
    } finally { repos.close(); }

    const migrated = new Database(path);
    expect(dutyRow(migrated, 'oc_valid')).toEqual({ alarm_json: null, scenarios_json: JSON.stringify({ alarm: binding }) });
    expect(dutyRow(migrated, 'oc_no_requester').alarm_json).toBeNull();
    expect(dutyRow(migrated, 'oc_invalid')).toEqual({ alarm_json: invalid, scenarios_json: null });
    expect(dutyRow(migrated, 'oc_responder_only')).toEqual({ alarm_json: null, scenarios_json: null });
    expect((migrated.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(40);
    migrated.close();
  });

  it('v37 库（已有调度索引）：升到 v38 后旧订阅照样转换，v37 的索引不受影响', async () => {
    const path = await databasePath('v37');
    createDatabaseAt(path, 37);
    const old = new Database(path);
    expect(dutyColumns(old)).not.toContain('scenarios_json');
    insertDuty(old, 'oc_valid', JSON.stringify(subscription), { responder: JSON.stringify({ appId: 'cli_bot', since: '2026-10-14T00:00:00.000Z' }) });
    old.close();

    const repos = createRepositories(path);
    try {
      expect(await repos.collaboration.getDuty({ appId: 'cli_bot', chatId: 'oc_valid' })).toMatchObject({ responder: { appId: 'cli_bot' }, scenarios: { alarm: binding } });
    } finally { repos.close(); }

    const migrated = new Database(path);
    expect(dutyRow(migrated, 'oc_valid')).toEqual({ alarm_json: null, scenarios_json: JSON.stringify({ alarm: binding }) });
    expect(migrated.prepare('SELECT version FROM schema_migrations WHERE version >= 37 ORDER BY version').all()).toEqual([{ version: 37 }, { version: 38 }, { version: 39 }, { version: 40 }]);
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'collaboration_actions_delivery_window'").get()).toBeDefined();
    migrated.close();
  });
});

describe('群分工的兼容读取', () => {
  it('只有 alarm_json 的行读出 scenarios.alarm；改别的包或接话人后告警绑定仍在，旧列被清掉', async () => {
    const path = await databasePath('compat');
    createRepositories(path).close();
    const db = new Database(path);
    insertDuty(db, 'oc_other_pack', JSON.stringify(subscription));
    insertDuty(db, 'oc_responder', JSON.stringify(subscription));
    insertDuty(db, 'oc_delete', JSON.stringify(subscription));
    insertDuty(db, 'oc_invalid', JSON.stringify({ ...subscription, levels: 'P0' }));
    insertDuty(db, 'oc_both', JSON.stringify(subscription), { scenarios: JSON.stringify({ alarm: { ...binding, enabled: false } }) });
    db.close();

    const repos = createRepositories(path);
    const collab = repos.collaboration;
    const scope = (chatId: string) => ({ appId: 'cli_bot', chatId });
    try {
      expect(await collab.getDuty(scope('oc_other_pack'))).toEqual({ scope: scope('oc_other_pack'), revision: 2, scenarios: { alarm: binding }, updatedAt: '2026-10-14T00:00:00.000Z' });
      // scenarios_json 里已有告警包时以它为准。
      expect((await collab.getDuty(scope('oc_both'))).scenarios).toEqual({ alarm: { ...binding, enabled: false } });

      expect((await collab.updateDuty(scope('oc_other_pack'), { expectedRevision: 2, scenarios: { 'team-faq': faq } }, 'ou_admin')).scenarios).toEqual({ alarm: binding, 'team-faq': faq });
      const responder = { appId: 'cli_bot', since: '2026-10-14T01:00:00.000Z' };
      expect(await collab.updateDuty(scope('oc_responder'), { expectedRevision: 2, responder }, 'ou_admin')).toMatchObject({ revision: 3, responder, scenarios: { alarm: binding } });
      expect(await collab.getDuty(scope('oc_responder'))).toMatchObject({ revision: 3, responder, scenarios: { alarm: binding } });
      // 删掉告警绑定后旧列不能再把它带回来。
      expect(await collab.updateDuty(scope('oc_delete'), { expectedRevision: 2, scenarios: { alarm: null } }, 'ou_admin')).not.toHaveProperty('scenarios');
      expect(await collab.getDuty(scope('oc_delete'))).not.toHaveProperty('scenarios');
      // 转不了的旧数据在不涉及告警包的更新里保持原样。
      expect(await collab.updateDuty(scope('oc_invalid'), { expectedRevision: 2, responder }, 'ou_admin')).not.toHaveProperty('scenarios');
    } finally { repos.close(); }

    const after = new Database(path);
    expect(dutyRow(after, 'oc_other_pack')).toEqual({ alarm_json: null, scenarios_json: JSON.stringify({ alarm: binding, 'team-faq': faq }) });
    expect(dutyRow(after, 'oc_responder')).toEqual({ alarm_json: null, scenarios_json: JSON.stringify({ alarm: binding }) });
    expect(dutyRow(after, 'oc_delete')).toEqual({ alarm_json: null, scenarios_json: null });
    expect(dutyRow(after, 'oc_invalid')).toEqual({ alarm_json: JSON.stringify({ ...subscription, levels: 'P0' }), scenarios_json: null });
    after.close();
  });
});

describe('旧告警初筛判定记录的兼容读取', () => {
  const scope = { appId: 'cli_bot', chatId: 'oc_group' };
  const cases = [
    { old: 'triaged', next: 'started', action: 'act', status: 'sent', reason: '起了初筛' },
    { old: 'level', next: 'filtered', action: 'silent', status: 'suppressed', reason: '级别不符' },
    { old: 'duplicate', next: 'duplicate', action: 'silent', status: 'suppressed', reason: '重复' },
    { old: 'rate_limited', next: 'rate_limited', action: 'silent', status: 'suppressed', reason: '超上限' },
    { old: 'not_responder', next: 'not_responder', action: 'silent', status: 'suppressed', reason: '不是接话人' },
    { old: 'no_requester', next: 'no_requester', action: 'silent', status: 'suppressed', reason: '没有确认人' }
  ] as const;
  const createdAt = (index: number) => new Date(Date.parse('2026-10-14T00:00:00.000Z') + index * 60_000).toISOString();
  const trigger = (index: number) => ({ id: `om_${index}`, messageId: `om_${index}`, senderId: 'ou_source', text: '合成告警文本' });

  async function seeded() {
    const path = await databasePath('decisions');
    createRepositories(path).close();
    const db = new Database(path);
    const insert = db.prepare(`INSERT INTO collaboration_decisions (id, app_id, chat_id, context_revision, policy_version, action, reason, evidence_ids_json, status, response, input_snapshot_json, created_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, '[]', ?, NULL, ?, ?)`);
    cases.forEach((item, index) => insert.run(`decision_alarm_${index}`, scope.appId, scope.chatId, 'alarm-triage', item.action, item.reason, item.status,
      JSON.stringify({ gate: 'alarm_triage', alarm: { outcome: item.old, fingerprint: `fp_${index}`, sourceAppId: 'cli_alarm' }, decider: { kind: 'rule', rule: `alarm_${item.old}`, trigger: trigger(index) } }), createdAt(index)));
    insert.run('decision_model', scope.appId, scope.chatId, 'v1', 'silent', 'model', 'suppressed', JSON.stringify({ prompt: 'x' }), createdAt(cases.length));
    db.close();
    return path;
  }

  it('getDecision/listDecisions 按第①类映射返回场景记录，库里的行不改写', async () => {
    const path = await seeded();
    const repos = createRepositories(path);
    try {
      const collab = repos.collaboration;
      for (const [index, item] of cases.entries()) {
        const expected = {
          id: `decision_alarm_${index}`, scope, contextRevision: 0, policyVersion: 'scenario:alarm@1.0.0', action: item.action, reason: item.reason,
          evidenceIds: [], status: item.status, createdAt: createdAt(index),
          inputSnapshot: {
            gate: 'scenario',
            scenario: { packId: 'alarm', version: '1.0.0', digest: 'legacy:alarm_triage', outcome: item.next, dedupeKey: `fp_${index}`, sourceAppId: 'cli_alarm' },
            decider: { kind: 'rule', rule: `scenario_${item.next}`, trigger: trigger(index) }
          }
        };
        const decision = await collab.getDecision(scope, `decision_alarm_${index}`);
        expect(decision).toEqual(expected);
        expect(decision!.inputSnapshot).not.toHaveProperty('alarm');
        expect(isDecisionGate(decision!)).toBe(true);
        expect(scenarioRecordOf(decision!)).toEqual(expected.inputSnapshot.scenario);
      }
      expect(await collab.getDecision(scope, 'decision_model')).toMatchObject({ policyVersion: 'v1', inputSnapshot: { prompt: 'x' } });

      const all = await collab.listDecisions(scope, 50);
      expect(all.truncated).toBe(false);
      expect(all.map(item => item.id)).toEqual(['decision_model', ...cases.map((_, index) => `decision_alarm_${index}`).reverse()]);
      // server 端按 scenarioRecordOf 取场景记录，按 act 且未失败统计去重和每小时上限：升级前起过的初筛仍然算数。
      const counted = all.filter(item => scenarioRecordOf(item)?.packId === 'alarm' && item.action === 'act' && item.status !== 'failed');
      expect(counted.map(item => scenarioRecordOf(item)!.dedupeKey)).toEqual(['fp_0']);
      const two = await collab.listDecisions(scope, 2);
      expect(two.truncated).toBe(true);
      expect(two.map(item => item.policyVersion)).toEqual(['v1', 'scenario:alarm@1.0.0']);

      // 状态更新和按 id 去重的写入也返回映射后的记录。
      expect(await collab.updateDecision(scope, 'decision_alarm_0', { status: 'failed' })).toMatchObject({ status: 'failed', inputSnapshot: { gate: 'scenario', scenario: { outcome: 'started' } } });
      expect(await collab.recordDecision({ ...(await collab.getDecision(scope, 'decision_alarm_1'))!, reason: 'ignored' })).toMatchObject({ reason: '级别不符', policyVersion: 'scenario:alarm@1.0.0' });
    } finally { repos.close(); }

    const db = new Database(path);
    const raw = db.prepare('SELECT policy_version, input_snapshot_json FROM collaboration_decisions WHERE id = ?').get('decision_alarm_1') as { policy_version: string; input_snapshot_json: string };
    expect(raw.policy_version).toBe('alarm-triage');
    expect(JSON.parse(raw.input_snapshot_json)).toMatchObject({ gate: 'alarm_triage', alarm: { outcome: 'level', fingerprint: 'fp_1' } });
    db.close();
  });
});

describe('listScenarioRecords', () => {
  const scope = { appId: 'cli_bot', chatId: 'oc_group' };
  const at = (minutes: number) => new Date(Date.parse('2026-10-14T00:00:00.000Z') + minutes * 60_000).toISOString();
  const record = (id: string, minutes: number, patch: { packId?: string; action?: 'act' | 'silent'; status?: 'sent' | 'failed' | 'suppressed' | 'candidate'; gate?: string } = {}) => ({
    id, scope, contextRevision: 0, policyVersion: 'test', action: patch.action ?? 'act', reason: 'r', evidenceIds: [], status: patch.status ?? 'sent', createdAt: at(minutes),
    inputSnapshot: patch.gate ? { gate: patch.gate } : { gate: 'scenario', scenario: { packId: patch.packId ?? 'alarm', version: '1.0.0', digest: 'd', outcome: 'started', dedupeKey: id } }
  });

  it('只返回本包、since 之后、act 且没失败的场景记录（含升级前的旧记录），新到旧；其他判定记录不占条数', async () => {
    const path = await databasePath('scenario-records');
    const repos = createRepositories(path);
    try {
      const collab = repos.collaboration;
      for (const item of [record('old', 0), record('in_1', 10), record('candidate', 20, { status: 'candidate' }), record('failed', 30, { status: 'failed' }),
        record('silent', 40, { action: 'silent', status: 'suppressed' }), record('faq', 50, { packId: 'team-faq' }), record('budget', 60, { gate: 'decision_budget', action: 'silent', status: 'suppressed' })]) {
        await collab.recordDecision(item);
      }
      for (let index = 0; index < 600; index++) await collab.recordDecision({ ...record(`other_${index}`, 70, { action: 'silent', status: 'suppressed' }), inputSnapshot: { prompt: 'x' } });
    } finally { repos.close(); }
    const db = new Database(path);
    db.prepare(`INSERT INTO collaboration_decisions (id, app_id, chat_id, context_revision, policy_version, action, reason, evidence_ids_json, status, response, input_snapshot_json, created_at)
      VALUES ('legacy', ?, ?, 0, 'alarm-triage', 'act', 'r', '[]', 'sent', NULL, ?, ?)`).run(scope.appId, scope.chatId,
      JSON.stringify({ gate: 'alarm_triage', alarm: { outcome: 'triaged', fingerprint: 'fp_legacy', sourceAppId: 'cli_alarm' } }), at(15));
    db.close();
    const reopened = createRepositories(path);
    try {
      const collab = reopened.collaboration;
      const listed = await collab.listScenarioRecords(scope, { packId: 'alarm', since: at(5), limit: 10 });
      expect(listed.truncated).toBe(false);
      expect(listed.map(item => item.id)).toEqual(['candidate', 'legacy', 'in_1']);
      expect(scenarioRecordOf(listed[1]!)).toMatchObject({ packId: 'alarm', outcome: 'started', dedupeKey: 'fp_legacy' });
      expect((await collab.listScenarioRecords(scope, { packId: 'team-faq', since: at(0), limit: 10 })).map(item => item.id)).toEqual(['faq']);
      const two = await collab.listScenarioRecords(scope, { packId: 'alarm', since: at(0), limit: 2 });
      expect([two.map(item => item.id), two.truncated]).toEqual([['candidate', 'legacy'], true]);
    } finally { reopened.close(); }
  });
});
