import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginAction, PluginApi, PluginQuery, PluginToolContext, PluginToolIdentity } from '@dutydeck/plugin-sdk';
import { createRepositories } from '@dutydeck/storage';
import register from '../index.mjs';
import { validateToolInput, validateToolSchema } from '../../../apps/server/src/plugins/business-tools.js';
import { PluginHost } from '../../../apps/server/src/plugins/host.js';
import { PluginStore } from '../../../apps/server/src/plugins/store.js';
import { PluginToolGrants } from '../../../apps/server/src/plugins/tool-grants.js';
import { PluginToolLedger } from '../../../apps/server/src/plugins/tool-ledger.js';
import { PluginBusinessToolService } from '../../../apps/server/src/plugins/tool-service.js';

const queries = new Map<string, PluginQuery>();
const actions = new Map<string, PluginAction>();
register({ registerQuery: (tool: PluginQuery) => queries.set(tool.name, tool), registerAction: (tool: PluginAction) => actions.set(tool.name, tool) } as PluginApi);
const identity: PluginToolIdentity = {
  sessionId: 'session', taskId: 'task', attemptId: 'attempt', runId: 'run',
  actor: { kind: 'channel', appId: 'cli_test', id: 'ou_requester' }, channel: 'lark',
  botAppId: 'cli_test', chatId: 'oc_test', cwd: '/tmp', workspaceRoot: '/tmp'
};
const context = (): PluginToolContext & { actionId: string } => ({
  binding: { plugin: 'alarm-ana', bindingId: 'binding_test', revision: 1, config: { endpoint: 'http://127.0.0.1:8765' }, getSecret: async () => 'synthetic-read' },
  identity, signal: new AbortController().signal, actionId: 'pt_test'
});
const mockResponse = (data: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data), { status })));
const query = (name: string, input: unknown, ctx = context()) => queries.get(name)!.execute(input, ctx);
const action = async (name: string, input: unknown, ctx = context()) => JSON.parse((await actions.get(name)!.execute(input, ctx)).receipt);
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const work of cleanup.splice(0).reverse()) await work(); });

describe('alarm-ana business tools', () => {
  it('registers only three read queries and the three explicit actions with valid bounded schemas', () => {
    expect([...queries.keys()]).toEqual(['alarm_trace', 'known_issues', 'ops_health']);
    expect([...actions.keys()]).toEqual(['ack', 'silence', 'comment']);
    for (const tool of [...queries.values(), ...actions.values()]) validateToolSchema(tool.inputSchema);
    for (const [name, input] of [
      ['alarm_trace', { mode: 'oops' }], ['alarm_trace', { mode: 'search', limit: 21 }],
      ['alarm_trace', { mode: 'identity', token: 'x' }], ['known_issues', { days: 181 }],
      ['known_issues', { limit: 11 }], ['silence', { source_key: 'main', record_id: 'rec1', minutes: 241 }],
      ['comment', { source_key: 'main', record_id: 'rec1', comment: 'x'.repeat(501) }],
      ['ack', { source_key: 'main', record_id: 'rec1', apply: false }]
    ] as const) expect(() => validateToolInput((queries.get(name) ?? actions.get(name))!.inputSchema, input)).toThrow();
  });

  it.each([
    [{ mode: 'identity', source_key: 'main', record_id: 'rec1' }, 'source_key=main&record_id=rec1'],
    [{ mode: 'message', message_id: 'om_root' }, 'message_id=om_root'],
    [{ mode: 'search', psm: 'service.foo', rule: 'timeout', since: '2026-10-30', limit: 3 }, 'psm=service.foo&rule=timeout&since=2026-10-30&limit=3']
  ])('maps trace lookup %j to the existing endpoint', async (input, expected) => {
    mockResponse({ found: true, matches: [{ source_key: 'main', record_id: 'rec1', via: ['thread_root_message'] }] });
    expect(await query('alarm_trace', input)).toMatchObject({ found: true });
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe(`http://127.0.0.1:8765/api/alarm-trace?${expected}`);
    expect(vi.mocked(fetch).mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'error', headers: { accept: 'application/json' } });
    expect(vi.mocked(fetch).mock.calls[0]![1]!.headers).not.toHaveProperty('authorization');
  });

  it.each([
    { mode: 'identity', source_key: 'main' }, { mode: 'message', message_id: 'bad' },
    { mode: 'identity', source_key: 'main', record_id: '../escape' },
    { mode: 'identity', source_key: 'main', record_id: 'rec1', limit: 2 }, { mode: 'search' }
  ])('rejects inconsistent trace input %j before HTTP', async input => {
    mockResponse({});
    expect(await query('alarm_trace', input)).toMatchObject({ error: { code: 'ALARM_ANA_INVALID_INPUT' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses only the independent read credential for history and removes nested identity fields', async () => {
    mockResponse({ query: { source_key: 'main', record_id: 'rec1', chat_id: 'oc_private' }, verdict: 'suspected_known',
      matches: [{ text: '已有结论 ou_private', handler: '值班人', trigger_open_id: 'ou_private', handling_chat_url: 'https://x/?openChatId=oc_private', todos: [{ text: '观察恢复', owner_open_id: 'ou_private' }] }], incomplete: false });
    const result = await query('known_issues', { source_key: 'main', record_id: 'rec1', include_cross_region: true, days: 7, limit: 3 });
    expect(result).toMatchObject({ verdict: 'suspected_known', matches: [{ text: '已有结论 [已省略身份]', todos: [{ text: '观察恢复' }] }] });
    expect(JSON.stringify(result)).not.toMatch(/ou_private|\"chat_id\"|open_id/);
    expect(result).toMatchObject({ matches: [{ handling_chat_url: 'https://x/?openChatId=oc_private' }] });
    expect(vi.mocked(fetch).mock.calls[0]![1]!.headers).toMatchObject({ authorization: 'Bearer synthetic-read' });
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain('include_cross_region=true');
  });

  it('reports a missing read token without touching HTTP', async () => {
    mockResponse({}); const ctx = context(); ctx.binding.getSecret = async () => undefined;
    expect(await query('known_issues', { alarm_id: '123' }, ctx)).toMatchObject({ error: { code: 'ALARM_ANA_READ_TOKEN_REQUIRED' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ source_key: 'main', record_id: 'rec1', alarm_id: '123' }, {}, { record_id: 'rec1' }])('rejects ambiguous known-issues identities %j', async input => {
    mockResponse({}); expect(await query('known_issues', input)).toMatchObject({ error: { code: 'ALARM_ANA_INVALID_INPUT' } }); expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps missing/unreadable/unknown evidence and limits large nested replies', async () => {
    mockResponse({ found: true, runtime_root: '/private', stages: {
      ack: { status: 'found', latest_observation: { ack_state: 'unknown', last_ack_by: 'ou_private' } },
      grading: { status: 'unreadable', sources: [{ file: 'classification_results.ndjson', state: 'unreadable' }], row: { label: '重要', reason: 'x'.repeat(5000), chat_id: 'oc_private', decision_meta: { raw_prompt: 'private' } } },
      card_delivery: { status: 'absent' }, feedback: { history_conclusion: Array.from({ length: 100 }, () => ({ note: 'x'.repeat(5000), open_id: 'ou_private' })) }
    } });
    const result = await query('alarm_trace', { mode: 'identity', source_key: 'main', record_id: 'rec1' });
    expect(result).toMatchObject({ truncated: true, stages: { ack: { latest_observation: { ack_state: 'unknown' } }, grading: { status: 'unreadable' }, card_delivery: { status: 'absent' } } });
    expect(JSON.stringify(result).length).toBeLessThan(64000);
    expect(JSON.stringify(result)).not.toMatch(/private|raw_prompt|runtime_root/);
  });

  it('preserves legacy followup conclusion objects without exposing hidden fields', async () => {
    // alarm_ana tests/test_alarm_trace.py preserves {root_cause: '限流'} from the ledger.
    mockResponse({ found: true, stages: { feedback: { oncall_followup: [
      { status: 'done', conclusion: { root_cause: '限流' } },
      { status: 'done', conclusion: { summary: '主备切换后恢复', root_cause: '机器故障', evidence: { chat_id: 'oc_hidden' }, private: 'hidden-value' } },
      { status: 'done', conclusion: '已恢复' }
    ] } } });
    const result = await query('alarm_trace', { mode: 'identity', source_key: 'main', record_id: 'rec1' });
    expect(result).toMatchObject({ stages: { feedback: { oncall_followup: [
      { conclusion: { root_cause: '限流' } },
      { conclusion: { summary: '主备切换后恢复', root_cause: '机器故障' } },
      { conclusion: '已恢复' }
    ] } } });
    expect(JSON.stringify(result)).not.toMatch(/hidden-value|oc_hidden|evidence|private/);
    expect(result).toMatchObject({ truncated: true });
  });

  it('marks omitted unsupported conclusion content as incomplete projection', async () => {
    mockResponse({ found: true, stages: { feedback: { oncall_followup: [
      { conclusion: { diagnosis: '未知旧结构', root_cause: { text: '不接受任意嵌套对象', private: 'hidden-value' } } }
    ] } } });
    const result = await query('alarm_trace', { mode: 'identity', source_key: 'main', record_id: 'rec1' });
    expect(result).toMatchObject({ truncated: true, stages: { feedback: { oncall_followup: [{ conclusion: {} }] } } });
    expect(JSON.stringify(result)).not.toMatch(/未知旧结构|hidden-value|任意嵌套/);
  });

  it.each([
    'https://applink.feishu.cn/client/message/open?message_id=om_fixture',
    '[报警原消息](https://applink.feishu.cn/client/message/open?message_id=om_fixture)',
    '[报警原消息](http://example.test/alarms/123?region=cn)'
  ])('retains a safe raw or Markdown message link %s', async link => {
    const target = link.startsWith('[') ? link.slice(link.indexOf('](') + 2, -1) : link;
    mockResponse({ found: true, stages: { grading: { row: { message_link: link } } } });
    expect(await query('alarm_trace', { mode: 'identity', source_key: 'main', record_id: 'rec1' })).toMatchObject({ stages: { grading: { row: { message_link: target } } } });
    mockResponse({ verdict: 'none', query: { message_link: link } });
    expect(await query('known_issues', { alarm_id: '123' })).toMatchObject({ query: { message_link: target } });
  });

  it.each([
    '[原消息](javascript:alert(1))', '[原消息](file:///srv/runtime/private.json)',
    '[原消息](https://user:password@example.test/alarms/123)',
    'https://user:password@example.test/alarms/123', '[原消息](//example.test/alarms/123)',
    '前缀[原消息](https://example.test/alarms/123)后缀'
  ])('rejects unsafe or partial Markdown message links %s', async link => {
    mockResponse({ found: true, stages: { grading: { row: { message_link: link } } } });
    expect(await query('alarm_trace', { mode: 'identity', source_key: 'main', record_id: 'rec1' })).toMatchObject({ stages: { grading: { row: { message_link: '' } } } });
  });

  it('redacts the backend results_missing health summary path while preserving its diagnosis', async () => {
    // ops_health.py emits exactly this summary when the classification file is absent.
    mockResponse({ available: true, report: { alerts: [{ code: 'results_missing', severity: 'high',
      summary: '分类结果文件不存在：/srv/alarm/runtime/classification_results.ndjson' }] } });
    const result = await query('ops_health', {});
    expect(result).toMatchObject({ report: { alerts: [{ code: 'results_missing', severity: 'high', summary: '分类结果文件不存在：[已省略路径]' }] } });
    expect(JSON.stringify(result)).not.toContain('/srv/alarm');
  });

  it.each([
    ['读取失败:/srv/alarm/runtime/data.json', '读取失败:[已省略路径]'],
    ['读取失败："/srv/alarm/runtime data/data.json"', '读取失败："[已省略路径]"'],
    [String.raw`读取失败：C:\alarm\runtime\data.json`, '读取失败：[已省略路径]']
  ])('redacts diagnostic paths in %s', async (error, expected) => {
    mockResponse({ outcome: 'unknown', error });
    expect(await action('ack', { source_key: 'main', record_id: 'rec1' })).toMatchObject({ outcome: 'unknown', error: expected });
  });

  it.each(['请求失败/超时持续升高', 'LLM / RCA / compare', 'a/b', '/'])('preserves ordinary diagnostic separators in health summaries and action errors: %s', async text => {
    const url = 'https://example.test/alarms/123?region=cn';
    const diagnostic = `${text}；证据 ${url}`;
    mockResponse({ available: true, report: { alerts: [{ code: 'degraded', severity: 'high', summary: diagnostic }] } });
    expect(await query('ops_health', {})).toEqual({ available: true, report: { alerts: [{ code: 'degraded', severity: 'high', summary: diagnostic }] }, truncated: false });
    mockResponse({ outcome: 'unknown', error: diagnostic });
    expect(await action('ack', { source_key: 'main', record_id: 'rec1' })).toEqual({ outcome: 'unknown', task_ref: 'pt_test', error: diagnostic, truncated: false });
  });

  it.each([
    ['/data00/home/x/alarm_ana/.state/results.jsonl', '[已省略路径]'],
    ['~/dutydeck/.dutydeck/dutydeck.db', '[已省略路径]'],
    ['读取失败=/data00/home/x/alarm_ana/.state/results.jsonl', '读取失败=[已省略路径]'],
    ['读取失败：~/dutydeck/.dutydeck/dutydeck.db', '读取失败：[已省略路径]']
  ])('redacts runtime path tokens at real boundaries in both diagnostic surfaces: %s', async (text, expected) => {
    const url = 'https://example.test/alarms/123?region=cn';
    mockResponse({ available: true, report: { alerts: [{ code: 'results_missing', severity: 'high', summary: `${text}；证据 ${url}` }] } });
    expect(await query('ops_health', {})).toMatchObject({ available: true, report: { alerts: [{ code: 'results_missing', severity: 'high', summary: `${expected}；证据 ${url}` }] } });
    mockResponse({ outcome: 'unknown', error: `${text}；证据 ${url}` });
    expect(await action('ack', { source_key: 'main', record_id: 'rec1' })).toMatchObject({ outcome: 'unknown', task_ref: 'pt_test', error: `${expected}；证据 ${url}` });
  });

  it('redacts quoted paths and exception diagnostics without breaking HTTP evidence', async () => {
    const url = 'https://example.test/alarms/123?region=cn';
    const error = `FileNotFoundError: [Errno 2] No such file or directory: '/srv/alarm/runtime/missing.json'; 状态 unknown；证据 ${url}`;
    mockResponse({ outcome: 'unknown', error });
    const receipt = await action('ack', { source_key: 'main', record_id: 'rec1' });
    expect(receipt).toMatchObject({ outcome: 'unknown', error: `FileNotFoundError: [Errno 2] No such file or directory: '[已省略路径]'; 状态 unknown；证据 ${url}` });
    mockResponse({ found: true, stages: { feedback: { oncall_followup: [{
      comment_error: '无法读取 "/srv/alarm/runtime/card.json"', last_error: `写入失败：/srv/alarm/runtime/state.json，参考 ${url}`
    }] } } });
    const trace = await query('alarm_trace', { mode: 'identity', source_key: 'main', record_id: 'rec1' });
    expect(trace).toMatchObject({ stages: { feedback: { oncall_followup: [{
      comment_error: '无法读取 "[已省略路径]"', last_error: `写入失败：[已省略路径]，参考 ${url}`
    }] } } });
    expect(JSON.stringify([receipt, trace])).not.toContain('/srv/alarm');
  });

  it('retains safety and incomplete flags when historical details exhaust the budget', async () => {
    mockResponse({ query: { record_id: 'rec1' }, verdict: 'suspected_known',
      matches: Array.from({ length: 10 }, () => ({ text: 'x'.repeat(1000), todos: Array.from({ length: 20 }, () => ({ text: 'x'.repeat(1000) })) })),
      security_sensitive: true, incomplete: true, warnings: ['部分台账读不了'] });
    const result = await query('known_issues', { source_key: 'main', record_id: 'rec1' });
    expect(result).toMatchObject({ security_sensitive: true, incomplete: true, verdict: 'suspected_known', truncated: true });
    expect(JSON.stringify(result).length).toBeLessThan(64000);
  });

  it('bounds JSON-escaped control characters in query results and action receipts', async () => {
    const controls = '\u0000'.repeat(5000);
    mockResponse({ found: true, candidates: Array.from({ length: 20 }, () => ({ reason: controls })) });
    const result = await query('alarm_trace', { mode: 'search', limit: 20 });
    expect(result).toMatchObject({ found: true, truncated: true });
    expect(JSON.stringify(result).length).toBeLessThan(64000);
    mockResponse({ outcome: 'skipped', action_id: controls, error: controls, source_key: controls });
    const receipt = await actions.get('ack')!.execute({ source_key: 'main', record_id: 'rec1' }, context());
    expect(JSON.parse(receipt.receipt)).toMatchObject({ outcome: 'skipped', task_ref: 'pt_test', truncated: true });
    expect(receipt.receipt.length).toBeLessThan(4000);
  });

  it('reads a health snapshot without running an operation and preserves its age', async () => {
    mockResponse({ available: true, generated_at: '2026-10-30T10:00:00+08:00', age_minutes: 60, report: { generated_at: '2026-10-30T10:00:00+08:00', inputs: { results_path: '/private' }, alerts: [{ code: 'worker_stale', severity: 'high', summary: '任务长时间无产出', chat_id: 'oc_private' }] } });
    expect(await query('ops_health', {})).toEqual({ available: true, generated_at: '2026-10-30T10:00:00+08:00', age_minutes: 60, report: { generated_at: '2026-10-30T10:00:00+08:00', alerts: [{ code: 'worker_stale', severity: 'high', summary: '任务长时间无产出' }] }, truncated: false });
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('http://127.0.0.1:8765/api/ops-health');
  });

  it.each([401, 403, 503])('returns actionable HTTP %i errors without echoing a response body', async status => {
    mockResponse({ token: 'private' }, status);
    const result = await query('ops_health', {});
    expect(result).toMatchObject({ error: { code: `ALARM_ANA_HTTP_${status}` } });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('returns a clear unreachable error and never retries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('private network data'); }));
    expect(await query('ops_health', {})).toMatchObject({ error: { code: 'ALARM_ANA_UNREACHABLE', message: expect.stringContaining('无法连接') } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds HTTP requests at eight seconds and reports timeouts', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(1));
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); })));
    expect(await query('ops_health', {})).toMatchObject({ error: { code: 'ALARM_ANA_TIMEOUT' } });
    expect(spy).toHaveBeenCalledWith(8000); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['https://127.0.0.1:8765', 'http://example.org', 'http://127.0.0.1:8765/api', 'http://user:secret@127.0.0.1:8765', 'http://127.0.0.1:8765/?token=secret'])('rejects unsafe endpoints %s without HTTP', async endpoint => {
    mockResponse({}); const ctx = context(); ctx.binding.config = { endpoint };
    expect(await query('ops_health', {}, ctx)).toMatchObject({ error: { code: 'ALARM_ANA_INVALID_INPUT' } }); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['ack', 'silence', 'comment'])('sends %s with the host action ID and backend-controlled write switch', async name => {
    mockResponse({ action_id: 'backend1', outcome: 'skipped', error: 'AGENT_ACTION_WRITE_ENABLED 未开启', dry_run: false });
    const input = { source_key: 'main', record_id: 'rec1', ...(name === 'silence' ? { minutes: 30 } : name === 'comment' ? { comment: '观察恢复' } : {}) };
    const result = await action(name, input);
    expect(result).toMatchObject({ outcome: 'skipped', dry_run: false, task_ref: 'pt_test' });
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(JSON.parse(String(init!.body))).toEqual({ ...input, action: name, apply: true, requester: 'ou_requester', task_ref: 'pt_test' });
    expect(init!.headers).not.toHaveProperty('authorization'); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['ok', 'skipped', 'failed', 'rejected', 'unknown'])('preserves outcome %s verbatim in a bounded receipt', async outcome => {
    mockResponse({ outcome, action_id: 'x'.repeat(5000), source_key: 'x'.repeat(5000), record_id: 'x'.repeat(5000), error: 'e'.repeat(5000), task_ref: 'forged' });
    const receipt = await actions.get('ack')!.execute({ source_key: 'main', record_id: 'rec1' }, context());
    expect(receipt.receipt.length).toBeLessThan(4000); expect(JSON.parse(receipt.receipt)).toMatchObject({ outcome, task_ref: 'pt_test' });
  });

  it('returns unknown on an interrupted POST, without retrying or claiming failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('lost reply'); }));
    expect(await action('ack', { source_key: 'main', record_id: 'rec1' })).toMatchObject({ outcome: 'unknown', task_ref: 'pt_test', error: { code: 'ALARM_ANA_UNREACHABLE' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it('loads an installed detached copy, enforces bot scope/grants, exposes query errors and deduplicates POSTs through the host', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dutydeck-alarm-ana-')); cleanup.push(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, 'source'); await cp(resolve(import.meta.dirname, '..'), source, { recursive: true });
  const dataDir = join(temp, 'data'); const store = new PluginStore(dataDir, join(temp, 'no-builtins'));
  await expect(store.install(source, { scope: 'bot:cli_test' })).rejects.toThrow();
  const installed = await store.install(source, { scope: 'bot:cli_test', yes: true });
  expect(installed.trustedCapabilities).toContain('providers');
  await rm(source, { recursive: true, force: true });
  const host = await PluginHost.load({ dataDir, builtinRoot: join(temp, 'no-builtins') }); cleanup.push(() => host.dispose());
  expect(host.diagnostics).toEqual([]); expect(host.businessTools.list({ botAppId: 'cli_other' })).toEqual([]);
  expect(host.businessTools.list({ botAppId: 'cli_test' })).toHaveLength(6);
  const manifest = host.active.find(item => item.entry.name === 'alarm-ana')!.plugin.manifest;
  const binding = host.bindings.save({ plugin: 'alarm-ana', botAppId: 'cli_test', chatId: 'oc_test', enabled: true, config: { endpoint: 'http://127.0.0.1:8765' }, secrets: {}, skills: ['alarm-ana/alarm-ops'], expectedRevision: 0 }, manifest);
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); cleanup.push(() => repos.close());
  const grants = new PluginToolGrants(repos.config);
  const service = new PluginBusinessToolService(host, grants, new PluginToolLedger(repos.config), { resolve: async () => ({ identity, assertCurrent: async () => {} }) });
  await expect(service.call('alarm-ana/ops_health', {}, 'query-1')).rejects.toMatchObject({ code: 'PLUGIN_TOOL_FORBIDDEN' });
  for (const [tool, effect] of [['ops_health', 'read'], ['ack', 'write']] as const) await grants.set({ id: tool, toolId: `alarm-ana/${tool}`, bindingId: binding.id, actor: identity.actor, effects: [effect], resources: ['*'], operations: ['invoke'] });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('unreachable'); }));
  expect(await service.call('alarm-ana/ops_health', {}, 'query-2')).toMatchObject({ output: { error: { code: 'ALARM_ANA_UNREACHABLE' } } });
  mockResponse({ outcome: 'skipped', dry_run: false, error: '写入开关关闭' });
  const result = await service.call('alarm-ana/ack', { source_key: 'main', record_id: 'rec1' }, 'ack-1') as { actionId: string; status: string; receipt: string };
  expect(result.status).toBe('succeeded'); expect(JSON.parse(result.receipt)).toMatchObject({ outcome: 'skipped', task_ref: result.actionId });
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)).task_ref).toBe(result.actionId);
  expect(await service.call('alarm-ana/ack', { source_key: 'main', record_id: 'rec1' }, 'ack-1')).toEqual(result);
  expect(fetch).toHaveBeenCalledTimes(1);
  await grants.revoke('ack');
  await expect(service.call('alarm-ana/ack', { source_key: 'main', record_id: 'rec1' }, 'ack-2')).rejects.toMatchObject({ code: 'PLUGIN_TOOL_FORBIDDEN' });
}, 30000);
