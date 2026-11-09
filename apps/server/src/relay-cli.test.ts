import { createCliProgram } from './cli-program.js';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { lazyBundleForTest } from '../../../tests/support/bundle-for-test.js';
import { RelayAskBroker, RelayError, relayHintLines, type RelayAskChoice } from '@dutydeck/relay';
import { askOutput, runSessionAsk, runSessionReport } from './relay-cli.js';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
// 真实 CLI 跑打包版，不让每次调用都经 TypeScript 加载器冷启动。
const cli = lazyBundleForTest('relay-cli', fileURLToPath(new URL('./cli.ts', import.meta.url)));
afterAll(() => cli.cleanup());
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function harness() {
  const requests: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }> = [];
  const broker = new RelayAskBroker({
    publish: async (_sessionId, event) => {
      if (event.kind === 'ask') await broker.answer(event.askId!, event.multiple ? 'a、b' : 'a');
    }
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    // CLI 子进程启动时会对同端口发一次 GET /（与 relay 无关）；不计入 relay 请求，也不让空 body 触发未处理异常。
    // 并行测试也会复用刚释放的端口：只认 relay 提问路径，请求体解析不了就断开这条连接。
    if (request.method !== 'POST' || request.url !== '/api/relay/sessions/self/ask') { response.statusCode = 404; response.end(); return; }
    let body: any;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { request.socket.destroy(); return; }
    requests.push({ url: request.url, authorization: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    try {
      const outcome = await broker.register({ sessionId: 'ses_test', question: body.question,
        timeoutMs: body.timeoutMs, choices: body.choices as RelayAskChoice[], multiple: body.multiple });
      response.end(JSON.stringify(outcome));
    } catch (error) {
      response.statusCode = error instanceof RelayError ? error.statusCode : 500;
      response.end(JSON.stringify({ error: { code: (error as RelayError).code, message: (error as Error).message } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    await broker.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address() as { port: number };
  const invoke = async (args: string[]) => { const entry = await cli.path(); return await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [entry, 'session', 'ask', '选哪个方案？', ...args], {
      cwd: workspace,
      env: { ...process.env, dutydeck_relay_url: `http://127.0.0.1:${address.port}/api/relay`, dutydeck_relay_token: 'fixture-token' },
      timeout: 12_000
    }, (error, stdout, stderr) => resolve({ code: error ? typeof error.code === 'number' ? error.code : -1 : 0, stdout, stderr }));
  }); };
  // 同进程走真实 HTTP 与 broker；子进程启动只留给需要验证 cli.ts 输出与退出码的用例。
  const env = { dutydeck_relay_url: `http://127.0.0.1:${address.port}/api/relay`, dutydeck_relay_token: 'fixture-token' };
  const ask = (options: Parameters<typeof runSessionAsk>[1]) => runSessionAsk('选哪个方案？', options, { env });
  return { requests, invoke, ask };
}

describe('session ask CLI over HTTP', () => {
  const choices = [{ label: '方案甲', value: 'a' }, { label: '方案乙', value: 'b' }];

  it('runs the on-demand help choice example through the real CLI and prints only the answer', async () => {
    const h = await harness();
    const hints = relayHintLines({ dutydeck_relay_url: 'http://localhost/api/relay', dutydeck_relay_token: 'fixture-token' }).join('\n');
    expect(hints).toContain('--help');
    expect(hints).not.toContain('立刻送达');
    let help = '';
    const program = createCliProgram('test');
    program.commands.find(command => command.name() === 'session')!.commands.find(command => command.name() === 'ask')!
      .exitOverride().configureOutput({ writeOut: value => { help += value; } });
    expect(() => program.parse(['node', 'dutydeck', 'session', 'ask', '--help'])).toThrowError(expect.objectContaining({ exitCode: 0 }));
    const example = help.match(/--choices '([^']+)'/);
    expect(example).not.toBeNull();
    expect(await h.invoke(['--choices', example![1]!, '--timeout', '60'])).toEqual({ code: 0, stdout: 'a\n', stderr: '' });
    expect(h.requests).toEqual([{ url: '/api/relay/sessions/self/ask', authorization: 'Bearer fixture-token',
      body: { question: '选哪个方案？', choices, timeoutMs: 60_000 } }]);
  });

  it('passes multiple selection and preserves JSON result output', async () => {
    const h = await harness();
    const result = await h.invoke(['--choices', JSON.stringify(choices), '--multiple', '--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'answered', answer: 'a、b', askId: expect.any(String) });
    expect(h.requests[0]?.body).toEqual({ question: '选哪个方案？', choices, multiple: true });
  });

  it('keeps plain asks free of choice fields', async () => {
    const h = await harness();
    expect(askOutput(await h.ask({}))).toEqual({ stdout: 'a\n', stderr: '', exitCode: 0 });
    expect(h.requests[0]?.body).toEqual({ question: '选哪个方案？' });
  });

  it('rejects malformed JSON before issuing HTTP', async () => {
    const h = await harness();
    const result = await h.invoke(['--choices', '{']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--choices');
    expect(h.requests).toHaveLength(0);
  });

  it('rejects multiple without choices before issuing HTTP', async () => {
    const h = await harness();
    await expect(h.ask({ multiple: true })).rejects.toMatchObject({ code: 'RELAY_INVALID_CHOICES', exitCode: 2, message: expect.stringContaining('--multiple') });
    expect(h.requests).toHaveLength(0);
  });

  it('uses broker validation for invalid choices through the real CLI', async () => {
    const h = await harness();
    const result = await h.invoke(['--choices', '[{"label":"甲","value":"a"},{"label":"乙","value":"a"}]']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/选项/);
    expect(h.requests).toHaveLength(1);
  });

  it.each(['null', '{}', '[]'])('uses broker validation for invalid choices %s', async choicesJson => {
    const h = await harness();
    await expect(h.ask({ choices: choicesJson })).rejects.toMatchObject({ code: 'RELAY_INVALID_CHOICES', exitCode: 2, message: expect.stringMatching(/选项/) });
    expect(h.requests).toHaveLength(1);
  });

  it('preserves timeout and cancelled output contracts', () => {
    expect(askOutput({ status: 'expired', askId: 'ask_1' })).toEqual({ stdout: '', stderr: '提问超时，用户未在期限内回答。\n', exitCode: 124 });
    expect(askOutput({ status: 'cancelled', reason: '会话结束' })).toEqual({ stdout: '', stderr: '会话结束。\n', exitCode: 3 });
  });
});

describe('session report CLI', () => {
  it('parses report arguments and sends them through the current-session transport', async () => {
    const handler = vi.fn();
    await createCliProgram('test', { sessionReport: handler }).parseAsync(['node', 'dutydeck', 'session', 'report', '--status', 'waiting', '--question', '今天发布吗？']);
    expect(handler).toHaveBeenCalledWith({ status: 'waiting', question: '今天发布吗？' });
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await runSessionReport({ status: 'blocked', summary: '缺少账号' }, { env: { dutydeck_relay_url: 'http://127.0.0.1:1234/api/relay', dutydeck_relay_token: 'fixture-token' }, fetcher: fetch as typeof globalThis.fetch });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:1234/api/relay/sessions/self/report');
    expect(JSON.parse(String((fetch.mock.calls[0] as any)[1].body))).toEqual({ status: 'blocked', summary: '缺少账号' });
    await expect(runSessionReport({ status: 'waiting' })).rejects.toMatchObject({ code: 'TASK_REPORT_INVALID' });
  });
});
