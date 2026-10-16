import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliProgram } from './cli-program.js';
import { runAgentCli } from './agent-cli.js';

const env = { dutydeck_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', dutydeck_group_tools_token: 'capability-token' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const roots: string[] = [];
afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** 走真实的命令树：解析参数、换成请求、统一输出。 */
async function agent(args: string[], reply: unknown = { done: true }, status = 200) {
  const fetcher = vi.fn(async () => response(reply, status));
  const out: string[] = [];
  const program = createCliProgram('0.0.5', { agent: (operation, values, options) => runAgentCli(operation, values, options, { env, fetcher: fetcher as typeof fetch }, text => { out.push(text); }) });
  await program.parseAsync(['node', 'dutydeck', 'agent', ...args]);
  const call = fetcher.mock.calls[0] as unknown as [string, RequestInit] | undefined;
  return {
    output: out.length ? JSON.parse(out.join('')) : undefined,
    lines: out.length,
    url: call?.[0].replace(env.dutydeck_group_tools_url, ''),
    method: call?.[1].method,
    body: call?.[1].body === undefined ? undefined : JSON.parse(String(call[1].body)),
    authorization: call ? new Headers(call[1].headers).get('authorization') : undefined,
    turn: call ? new Headers(call[1].headers).get('x-dutydeck-work-turn') : undefined,
    calls: fetcher.mock.calls.length
  };
}

describe('dutydeck agent', () => {
  it('查看类发 GET 到 views，stdout 只有一个 {ok,data}，不带 --turn', async () => {
    const status = await agent(['status'], { agent: 'codex', text: '…' });
    expect(status).toMatchObject({ url: '/views/status', method: 'GET', body: undefined, authorization: 'Bearer capability-token', turn: null, lines: 1, output: { ok: true, data: { agent: 'codex' } } });
    expect(process.exitCode).toBeUndefined();
    for (const [args, url] of [[['agents'], '/views/agents'], [['tasks', '--page', '2'], '/views/tasks?page=2'], [['queue'], '/views/queue'], [['schedules'], '/views/schedules'], [['ci'], '/views/ci']] as const) {
      expect((await agent([...args])).url).toBe(url);
    }
    expect(await agent(['group', 'messages', '--limit', '5', '--query', '发布'])).toMatchObject({ url: '/messages?limit=5&query=%E5%8F%91%E5%B8%83', method: 'GET' });
    expect(await agent(['history', 'show', 'task_1', '--field', 'answer'])).toMatchObject({ url: '/history/task_1?field=answer', method: 'GET' });
    expect(await agent(['memory', 'search', '测试命令', '--limit', '3'])).toMatchObject({ url: `/memory/search?q=${encodeURIComponent('测试命令')}&limit=3` });
    expect(await agent(['work', 'show', 'goal_1'])).toMatchObject({ url: '/work-items/goal_1' });
    expect(await agent(['collaborate', 'status'])).toMatchObject({ url: '/collaboration' });
  });

  it('写入命令用正常参数，发到 actions；--dry-run 交给服务预览', async () => {
    expect(await agent(['session', 'new', '--agent', 'codex', '--workspace', 'worktree', '--task', '修复登录页报错'])).toMatchObject({
      url: '/actions/session.new', method: 'POST', body: { agent: 'codex', workspace: 'worktree', task: '修复登录页报错' } });
    expect(await agent(['session', 'new', '--handoff', '--note', '接着查', '--dry-run'])).toMatchObject({ url: '/actions/session.new', body: { handoff: true, note: '接着查', dryRun: true } });
    expect(await agent(['retry'])).toMatchObject({ url: '/actions/retry', body: {} });
    expect(await agent(['plan', '--task', '先出计划'])).toMatchObject({ url: '/actions/plan', body: { task: '先出计划' } });
    expect(await agent(['queue', 'cancel', '2'])).toMatchObject({ url: '/actions/queue.cancel', body: { index: 2 } });
    expect(await agent(['queue', 'top', '1', '--dry-run'])).toMatchObject({ url: '/actions/queue.top', body: { index: 1, dryRun: true } });
    expect(await agent(['schedule', 'enable', 'sch_1'])).toMatchObject({ url: '/actions/schedule.enable', body: { id: 'sch_1' } });
    expect(await agent(['schedule', 'disable', 'sch_1'])).toMatchObject({ url: '/actions/schedule.disable', body: { id: 'sch_1' } });
    expect(await agent(['schedule', 'create', '--cron', '0 9 * * *', '--prompt', '汇总告警', '--dry-run'])).toMatchObject({ url: '/schedules', body: { cron: '0 9 * * *', prompt: '汇总告警', dryRun: true } });
    expect(await agent(['access', 'grant', '--member', 'Bob', '--member', 'Carol'])).toMatchObject({ url: '/actions/access.grant', body: { members: ['Bob', 'Carol'] } });
    expect(await agent(['access', 'revoke'])).toMatchObject({ url: '/actions/access.revoke', body: {} });
    expect(await agent(['pr', 'open', '--title', '修复'])).toMatchObject({ url: '/actions/pr.open', body: { title: '修复' } });
    expect(await agent(['ci', 'wait', '--workflow', 'build.yml'])).toMatchObject({ url: '/actions/ci.wait', body: { workflow: 'build.yml' } });
    expect(await agent(['ci', 'fix'])).toMatchObject({ url: '/actions/ci.fix' });
    expect(await agent(['ci', 'cancel', 'ci_1'])).toMatchObject({ url: '/actions/ci.cancel', body: { id: 'ci_1' } });
    expect(await agent(['repair', '--dry-run'])).toMatchObject({ url: '/actions/repair', body: { dryRun: true } });
  });

  it('迁来的直接写入命令语义不变；--dry-run 不发请求，只说明会发什么', async () => {
    expect(await agent(['group', 'send', '已定位', '--reply-to', 'om_1', '--in-thread'])).toMatchObject({ url: '/send', method: 'POST', body: { content: '已定位', replyTo: 'om_1', inThread: true } });
    expect(await agent(['group', 'send', '<完整答复>', '--final'])).toMatchObject({ url: '/send', body: { content: '<完整答复>', final: true } });
    expect(await agent(['memory', 'remove', 'mem_1'])).toMatchObject({ url: '/memory/mem_1', method: 'DELETE' });
    expect(await agent(['work', 'run', 'tpl_1', '2', '新目标', '--key', 'k1'])).toMatchObject({ url: '/work-items/templates/tpl_1/run', body: { version: 2, goal: '新目标', idempotencyKey: 'k1' } });
    const preview = await agent(['group', 'send', 'hi', '--dry-run']);
    expect(preview.calls).toBe(0);
    expect(preview.output).toEqual({ ok: true, data: { dryRun: true, risk: 'write', needsConfirmation: false, request: { method: 'POST', path: '/send', body: { content: 'hi' } }, effect: expect.any(String) } });
    const mandate = await agent(['collaborate', 'mandate-create', '--json', '{"id":"m1","goal":"盯发布"}', '--dry-run']);
    expect(mandate).toMatchObject({ calls: 0, output: { data: { risk: 'write-confirm', needsConfirmation: true, request: { path: '/collaboration/mandates', body: { id: 'm1', goal: '盯发布' } } } } });
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-agent-cli-')); roots.push(root);
    await writeFile(join(root, 'brief.json'), '{"goal":"拆任务","idempotencyKey":"b1"}');
    expect(await agent(['work', 'delegate', '--file', join(root, 'brief.json')])).toMatchObject({ url: '/work-items/delegations', body: { goal: '拆任务', idempotencyKey: 'b1' } });
  });

  it('失败也只有一个 JSON：服务的错误原样带出 params，退出码非 0', async () => {
    const rejected = await agent(['queue', 'cancel', '9'], { error: { code: 'INVALID_ARGUMENT', message: '<编号>：从 1 开始', params: [{ name: '<编号>', reason: '从 1 开始' }] } }, 400);
    expect(rejected).toMatchObject({ lines: 1, output: { ok: false, error: { code: 'INVALID_ARGUMENT', params: [{ name: '<编号>', reason: '从 1 开始' }] } } });
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const missing = await agent(['collaborate', 'followup-create', '--json', '{"goal":"x"}']);
    expect(missing).toMatchObject({ calls: 0, output: { ok: false, error: { code: 'INVALID_ARGUMENT', params: [{ name: '--json/--file' }] } } });
    const broken = await agent(['collaborate', 'feedback', 'dec_1', '--json', '{']);
    expect(broken.output.error.params).toEqual([{ name: '--json', reason: '不是合法的 JSON' }]);
    // 没有会话凭证：结构化错误。
    const out: string[] = [];
    await runAgentCli('status', [], {}, { env: {} }, text => { out.push(text); });
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: false, error: { code: 'GROUP_TOOL_CONTEXT_REQUIRED' } });
  });

  it('命令行用法错误指出参数，可选值写进 reason', async () => {
    const usage = (args: string[]) => agent(args).then(() => { throw new Error('应当报错'); }, (error: any) => error);
    expect(await usage(['session', 'new', '--workspace', 'x'])).toMatchObject({ code: 'INVALID_ARGUMENT', params: [{ name: '--workspace', reason: '可选：shared、worktree' }], hint: expect.stringContaining('session new --help') });
    expect(await usage(['tasks', '--page', '0'])).toMatchObject({ params: [{ name: '--page', reason: '要是不小于 1 的整数' }] });
    expect(await usage(['queue', 'cancel', 'abc'])).toMatchObject({ params: [{ name: '<index>', reason: '要是不小于 1 的整数' }] });
    expect(await usage(['plan'])).toMatchObject({ params: [{ name: '--task', reason: '必填' }] });
    expect(await usage(['retry', '--force'])).toMatchObject({ params: [{ name: '--force', reason: '不支持这个参数' }] });
    expect(await usage(['nope'])).toMatchObject({ code: 'UNKNOWN_COMMAND', params: [{ name: '<命令>', reason: expect.stringMatching(/^没有这个命令：nope；可用：.*session/) }] });
    expect(await usage(['queue', 'drop', '1'])).toMatchObject({ code: 'UNKNOWN_COMMAND', params: [{ name: '<命令>', reason: '没有这个命令：drop；可用：cancel、top' }] });
    expect(await usage(['retry', 'now'])).toMatchObject({ code: 'INVALID_ARGUMENT', params: [{ name: '<参数>', reason: '多余的参数' }] });
    expect(await usage(['schedule', 'enable'])).toMatchObject({ params: [{ name: '<id>', reason: '必填' }] });
  });
});
