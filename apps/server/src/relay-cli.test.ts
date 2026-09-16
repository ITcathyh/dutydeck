import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayAskBroker, RelayError, relayHintLines, type RelayAskChoice } from '@dutydeck/relay';
import { askOutput } from './relay-cli.js';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
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
    const body = JSON.parse(Buffer.concat(chunks).toString());
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
  const invoke = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--import', 'tsx', cli, 'session', 'ask', '选哪个方案？', ...args], {
      cwd: workspace,
      env: { ...process.env, NODE_OPTIONS: '--conditions=development', dutydeck_relay_url: `http://127.0.0.1:${address.port}/api/relay`, dutydeck_relay_token: 'fixture-token' },
      timeout: 12_000
    }, (error, stdout, stderr) => resolve({ code: error ? typeof error.code === 'number' ? error.code : -1 : 0, stdout, stderr }));
  });
  return { requests, invoke };
}

describe('session ask CLI over HTTP', () => {
  const choices = [{ label: '方案甲', value: 'a' }, { label: '方案乙', value: 'b' }];

  it('runs the injected choice example through the real CLI and prints only the answer', async () => {
    const h = await harness();
    const hints = relayHintLines({ dutydeck_relay_url: 'http://localhost/api/relay', dutydeck_relay_token: 'fixture-token' }).join('\n');
    const example = hints.match(/--choices '([^']+)'/);
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
    expect(await h.invoke([])).toEqual({ code: 0, stdout: 'a\n', stderr: '' });
    expect(h.requests[0]?.body).toEqual({ question: '选哪个方案？' });
  });

  it.each([
    ['malformed JSON', ['--choices', '{'], '--choices'],
    ['multiple without choices', ['--multiple'], '--multiple']
  ])('rejects %s before issuing HTTP', async (_name, args, message) => {
    const h = await harness();
    const result = await h.invoke(args as string[]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(message);
    expect(h.requests).toHaveLength(0);
  });

  it.each(['null', '{}', '[]', '[{"label":"甲","value":"a"},{"label":"乙","value":"a"}]'])('uses broker validation for invalid choices %s', async choicesJson => {
    const h = await harness();
    const result = await h.invoke(['--choices', choicesJson]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/选项/);
    expect(h.requests).toHaveLength(1);
  });

  it('preserves timeout and cancelled output contracts', () => {
    expect(askOutput({ status: 'expired', askId: 'ask_1' })).toEqual({ stdout: '', stderr: '提问超时，用户未在期限内回答。\n', exitCode: 124 });
    expect(askOutput({ status: 'cancelled', reason: '会话结束' })).toEqual({ stdout: '', stderr: '会话结束。\n', exitCode: 3 });
  });
});
