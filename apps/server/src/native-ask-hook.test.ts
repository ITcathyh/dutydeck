import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayAskBroker, type RelayAskChoice } from '@dutydeck/relay';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import { readNativeAskPayload, runNativeAskHook } from './native-ask-hook.js';

const env = { dutydeck_relay_url: 'http://127.0.0.1/api/relay', dutydeck_relay_token: 'fixture-token' };
const payload = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [
  { question: '要检查哪些项？', multiSelect: true, options: [
    { label: '代码', description: '检查实现' }, { label: '文档', description: '检查说明' },
  ] },
  { question: '下一步？', multiSelect: false, options: [{ label: '继续' }, { label: '暂停' }] },
] } };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe('native Claude questions over the session relay', () => {
  it('executes the generated native hook as a real subprocess and returns exact answers to Claude', async () => {
    const received: any[] = [];
    const broker = new RelayAskBroker({ publish: async (_session, event) => {
      if (event.kind === 'ask') await broker.answer(event.askId!, event.multiple ? '代码、文档' : '稍后再继续');
    } });
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      received.push({ url: request.url, token: request.headers.authorization, ...body });
      const result = await broker.register({ sessionId: 'ses_native', question: body.question,
        choices: body.choices as RelayAskChoice[], multiple: body.multiple });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(result));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => { await broker.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const port = (server.address() as { port: number }).port;
    const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const hookEnv = { ...env, dutydeck_relay_url: `http://127.0.0.1:${port}/api/relay`,
      dutydeck_relay_command: `'${process.execPath}' --import tsx '${cli}'` };
    const args = createCliAdapter('claude-code').buildArgs({ sessionId: 'ses_native', env: hookEnv });
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    const hook = settings.hooks.PreToolUse[0];
    expect(hook.matcher).toBe('^AskUserQuestion$');
    expect(hook.hooks[0].command).not.toContain('fixture-token');
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile('/bin/sh', ['-c', hook.hooks[0].command], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: { ...process.env, ...hookEnv, NODE_OPTIONS: '--conditions=development' }, timeout: 12_000,
      }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      child.stdin!.end(JSON.stringify(payload));
    });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: {
        ...payload.tool_input, answers: { '要检查哪些项？': '代码、文档', '下一步？': '稍后再继续' },
      },
    } });
    expect(received).toEqual([
      { url: '/api/relay/sessions/self/ask', token: 'Bearer fixture-token', question: '要检查哪些项？\n代码：检查实现\n文档：检查说明',
        choices: [{ label: '代码' }, { label: '文档' }], multiple: true },
      { url: '/api/relay/sessions/self/ask', token: 'Bearer fixture-token', question: '下一步？',
        choices: [{ label: '继续' }, { label: '暂停' }] },
    ]);
    expect(broker.listPending()).toHaveLength(0);
  });

  it.each(['expired', 'cancelled'])('does not approve an unanswered native question: %s', async status => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status }), { status: 200 }));
    const result = JSON.parse(await runNativeAskHook(payload, { env, fetcher }));
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.updatedInput).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('ignores other tool permissions and standalone sessions without sending anything', async () => {
    const fetcher = vi.fn();
    expect(await runNativeAskHook({ ...payload, tool_name: 'Bash' }, { env, fetcher })).toBe('');
    expect(await runNativeAskHook({ ...payload, hook_event_name: 'PermissionRequest' }, { env, fetcher })).toBe('');
    expect(await runNativeAskHook(payload, { env: {}, fetcher })).toBe('');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects ambiguous inputs before sending and does not leak transport details', async () => {
    const fetcher = vi.fn(async () => { throw new Error('fixture-secret'); });
    const result = await runNativeAskHook(payload, { env, fetcher });
    expect(result).not.toContain('fixture-secret');
    expect(JSON.parse(result).hookSpecificOutput.permissionDecision).toBe('deny');
    fetcher.mockClear();
    expect(JSON.parse(await runNativeAskHook({ ...payload, tool_input: { questions: [payload.tool_input.questions[0], payload.tool_input.questions[0]] } }, { env, fetcher }))
      .hookSpecificOutput.permissionDecision).toBe('deny');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds stdin and preserves questions with a prototype-like title', async () => {
    await expect(readNativeAskPayload(Readable.from([Buffer.alloc(1024 * 1024 + 1)]))).rejects.toThrow('too large');
    const native = { ...payload, tool_input: { questions: [{ ...payload.tool_input.questions[0], question: '__proto__' }] } };
    expect(await readNativeAskPayload(Readable.from([JSON.stringify(native)]))).toEqual(native);
    const result = JSON.parse(await runNativeAskHook(native, { env,
      fetcher: async () => new Response(JSON.stringify({ status: 'answered', answer: '代码' })) }));
    expect(Object.keys(result.hookSpecificOutput.updatedInput.answers)).toEqual(['__proto__']);
    expect(result.hookSpecificOutput.updatedInput.answers.__proto__).toBe('代码');
  });
});
