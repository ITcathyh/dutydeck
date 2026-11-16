import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleCliForTest } from '../../../tests/support/bundle-for-test.js';
import { createCliProgram } from './cli-program.js';
import { internalAgentRoute } from './internal-agent-route.js';

let fullCli: string;
let internalCli: string;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  const [full, internal] = await Promise.all([
    bundleCliForTest('full-cli-parity'),
    bundleCliForTest('internal-agent-cli-parity', join(process.cwd(), 'apps/server/src/internal-agent-cli.ts'))
  ]);
  fullCli = full.path;
  internalCli = internal.path;
  cleanups.push(full.cleanup, internal.cleanup);
});
afterAll(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

interface RecordedRequest {
  method?: string;
  url?: string;
  body: string;
  authorization?: string;
  workTurn?: string;
  toolTurn?: string;
  resultTurn?: string;
}
interface Reply { status?: number; body?: unknown; raw?: string; contentType?: string }
interface InvokeOptions {
  stdin?: string;
  credentials?: boolean;
  env?: Record<string, string>;
  dotenv?: boolean;
  card?: boolean;
  respond?(request: RecordedRequest, count: number): Reply;
  args(root: string): string[];
}
interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  requests: RecordedRequest[];
}

async function invoke(entry: string, options: InvokeOptions): Promise<CliResult> {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-internal-cli-parity-'));
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const recorded: RecordedRequest = {
      method: request.method,
      url: request.url,
      body: Buffer.concat(chunks).toString(),
      authorization: request.headers.authorization,
      workTurn: request.headers['x-dutydeck-work-turn'] as string | undefined,
      toolTurn: request.headers['x-dutydeck-tool-turn'] as string | undefined,
      resultTurn: request.headers['x-dutydeck-result-turn'] as string | undefined
    };
    if (!request.url?.startsWith('/api/')) { response.statusCode = 404; response.end(); return; }
    requests.push(recorded);
    const reply = options.respond?.(recorded, requests.length) ?? defaultReply(recorded);
    response.statusCode = reply.status ?? 200;
    response.setHeader('content-type', reply.contentType ?? 'application/json');
    response.end(reply.raw ?? JSON.stringify(reply.body ?? { done: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    if (options.dotenv) await mkdir(join(root, '.env'));
    if (options.card) await writeFile(join(root, 'card.json'), JSON.stringify({ elements: [{ tag: 'markdown', content: 'card text' }] }));
    const port = (server.address() as { port: number }).port;
    const credentials = options.credentials === false ? {} : {
      dutydeck_group_tools_url: `http://127.0.0.1:${port}/api/lark/agent-tools`,
      dutydeck_group_tools_token: 'group-token',
      dutydeck_relay_url: `http://127.0.0.1:${port}/api/relay`,
      dutydeck_relay_token: 'relay-token'
    };
    return await new Promise<CliResult>((resolve, reject) => {
      const child = execFile(process.execPath, [entry, ...options.args(root)], {
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH!, TMPDIR: tmpdir(), NODE_COMPILE_CACHE: join(dirname(entry), 'compile-cache'), ...credentials, ...options.env },
        timeout: 15_000,
        encoding: 'utf8'
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') { reject(error); return; }
        const generatedUuid = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
        const normalize = (text: string) => text.replaceAll(root, '<cwd>').replace(generatedUuid, '<uuid>');
        resolve({
          code: error ? error.code as number : 0,
          stdout: normalize(stdout),
          stderr: normalize(stderr),
          requests: requests.map(request => ({ ...request, body: normalize(request.body) }))
        });
      });
      child.stdin!.end(options.stdin);
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

const askExpiresAt = new Date(Date.now() + 60_000).toISOString();
function defaultReply(request: RecordedRequest): Reply {
  if (request.url?.endsWith('/ask-wait') || request.url?.endsWith('/ask-result')) return { body: { status: 'answered', answer: 'saved', expiresAt: askExpiresAt } };
  if (request.url?.endsWith('/ask')) return { body: { status: 'answered', answer: 'answer', askId: 'ask_fixture' } };
  if (request.url?.endsWith('/permission')) return { body: { status: 'approved' } };
  return { body: { done: true } };
}

async function parity(args: string[] | InvokeOptions['args'], options: Omit<InvokeOptions, 'args'> = {}) {
  const normalized: InvokeOptions = typeof args === 'function' ? { ...options, args } : { ...options, args: () => args };
  const full = await invoke(fullCli, normalized);
  const internal = await invoke(internalCli, normalized);
  expect(internal, `argv: ${normalized.args('<cwd>').join(' ')}`).toEqual(full);
  return full;
}

describe('internal Agent CLI black-box parity', () => {
  it('matches every recursive Agent help page', async () => {
    const agent = createCliProgram('test').commands.find(command => command.name() === 'agent')!;
    const paths: string[][] = [[]];
    const visit = (command: typeof agent, prefix: string[]) => {
      for (const child of command.commands) {
        const path = [...prefix, child.name()];
        paths.push(path);
        visit(child, path);
      }
    };
    visit(agent, []);
    expect(paths.length).toBeGreaterThan(50);
    for (const path of paths) await parity(['agent', ...path, '--help']);
  }, 120_000);

  it.each([
    ['agent read', ['agent', '--turn', 'turn-1', 'group', 'messages', '--limit', '5', '--query', '发布']],
    ['agent final', ['agent', '--turn', 'turn-1', 'group', 'send', '最终答复', '--final', '--idempotency-key', 'stable-send']],
    ['agent dry run', ['agent', '--turn', 'turn-1', 'group', 'send', 'preview', '--dry-run']],
    ['agent usage choice', ['agent', 'session', 'new', '--workspace', 'bad']],
    ['agent unknown option', ['agent', 'retry', '--force']],
    ['agent missing option value', ['agent', 'group', 'messages', '--limit']],
    ['agent missing required option', ['agent', 'plan']],
    ['agent unknown command', ['agent', 'not-a-command']],
    ['session send', ['session', 'send', '真实进展']],
    ['session report', ['session', 'report', '--status', 'waiting', '--question', '继续吗？']],
    ['session ask', ['session', 'ask', '选哪个？', '--request-id', 'stable-ask', '--choices', '[{"label":"方案甲"}]', '--timeout', '60']],
    ['session ask result', ['session', 'ask-result', 'stable-ask']],
    ['session ask wait', ['session', 'ask-wait', 'stable-ask', '--json']],
    ['session invalid choices', ['session', 'ask', '选哪个？', '--request-id', 'stable-ask', '--choices', '{']],
    ['session missing argument', ['session', 'send']],
    ['session unknown option', ['session', 'send', 'text', '--force']],
    ['session invalid report', ['session', 'report', '--status', 'waiting']],
    ['tool list', ['tool', 'list', '--turn', 'turn-1']],
    ['tool call', ['tool', 'call', 'tickets/close', '--turn', 'turn-1', '--call-id', 'stable-call', '--json', '{"ticket":"T1"}']],
    ['plugin tool list', ['plugin-tool', 'list', '--turn', 'turn-1']],
    ['plugin tool call', ['plugin-tool', 'call', 'files/deliver', '--turn', 'turn-1', '--call-id', 'stable-result', '--json', '{"paths":["a.txt"]}']]
  ])('%s has identical output and HTTP requests', async (_label, args) => { await parity(args); }, 30_000);

  it('matches card-file requests', async () => {
    await parity(root => ['agent', '--turn', 'turn-1', 'group', 'send', 'summary', '--final', '--card-file', join(root, 'card.json')], { card: true });
  });

  it.each([
    ['agent no credentials', ['agent', '--turn', 'turn-1', 'status']],
    ['session no credentials', ['session', 'send', 'text']],
    ['tool no credentials', ['tool', 'list', '--turn', 'turn-1']],
    ['plugin tool no credentials', ['plugin-tool', 'list', '--turn', 'turn-1']]
  ])('%s', async (_label, args) => { await parity(args, { credentials: false }); });

  it.each([
    ['agent 4xx', ['agent', '--turn', 'turn-1', 'group', 'messages'], { status: 400, body: { error: { code: 'INVALID_ARGUMENT', message: 'bad', params: [{ name: '--limit', reason: 'bad' }] } } }],
    ['agent 5xx', ['agent', '--turn', 'turn-1', 'group', 'messages'], { status: 503, raw: 'not json', contentType: 'text/plain' }],
    ['agent success non-JSON', ['agent', '--turn', 'turn-1', 'group', 'messages'], { raw: 'not json', contentType: 'text/plain' }],
    ['session 4xx', ['session', 'send', 'text'], { status: 400, body: { error: { code: 'RELAY_INVALID', message: 'bad request' } } }],
    ['session 5xx', ['session', 'send', 'text'], { status: 503, body: { error: { code: 'RELAY_UNAVAILABLE', message: 'unavailable' } } }],
    ['session success non-JSON', ['session', 'send', 'text'], { raw: 'not json', contentType: 'text/plain' }]
  ])('%s', async (_label, args, reply) => { await parity(args, { respond: () => reply as Reply }); });

  it('matches native ask and permission-hook allow/deny output', async () => {
    const native = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '继续吗？', options: [{ label: '继续' }] }] } });
    await parity(['session', 'native-ask'], { stdin: native });
    const permission = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pnpm test' }, cwd: '/tmp' });
    await parity(['session', 'permission-hook'], { stdin: permission });
    await parity(['session', 'permission-hook'], { stdin: permission, respond: () => ({ body: { status: 'rejected', reason: 'denied' } }) });
    await parity(['session', 'permission-hook'], { stdin: 'not json' });
  });

  it.each([
    ['legacy group', ['--agent-turn', 'turn-1', 'group', 'messages', '--limit', '3']],
    ['legacy history', ['--agent-turn', 'turn-1', 'history', 'list']],
    ['legacy memory', ['--agent-turn', 'turn-1', 'memory', 'list']],
    ['legacy work', ['--agent-turn', 'turn-1', 'work', 'list']],
    ['legacy collaborate', ['collaborate', 'followup-create', '--turn', 'turn-1', '--json', '{"id":"f1"}']],
    ['legacy command', ['command', '/status', '--turn', 'turn-1']],
    ['legacy schedule request', ['schedule', 'request', '--turn', 'turn-1', '--prompt', 'check', '--every', '30']],
    ['session management', ['session', 'list']],
    ['tool grants management', ['tool-grant', 'list']],
    ['public version', ['--version']],
    ['unsupported global shape', ['--agent-turn', 'turn-1', 'agent', 'status']]
  ])('falls back to the full CLI for %s', async (_label, args) => { await parity(args); });

  it('keeps Agent-owned cwd on the fast route and rejects global-option shapes before environment setup', async () => {
    expect(internalAgentRoute(['node', 'internal', 'agent', 'session', 'new', '--cwd', '/tmp', '--task', 'x'])).toBe('agent');
    expect(internalAgentRoute(['node', 'internal', 'agent', 'session', 'fork', '--cwd=/tmp'])).toBe('agent');
    expect(internalAgentRoute(['node', 'internal', 'agent', 'group', 'send', '--', '--host'])).toBe('agent');
    expect(internalAgentRoute(['node', 'internal', 'agent', '--cwd', '/tmp', 'session', 'new'])).toBeUndefined();
    expect(internalAgentRoute(['node', 'internal', 'agent', 'session', '--cwd', '/tmp', 'new'])).toBeUndefined();
    await parity(['agent', '--turn', 'turn-1', 'session', 'new', '--cwd', '/tmp', '--task', 'x']);
    await parity(['agent', '--turn', 'turn-1', 'session', 'fork', '--cwd=/tmp']);
    await parity(['agent', '--turn', 'turn-1', 'group', 'send', '--', '--host']);
  }, 30_000);

  it('falls back for every current public root option after Agent, session and tool', async () => {
    const values: Record<string, string[]> = {
      '--agent-turn': ['turn-1'], '--host': ['127.0.0.1'], '--port': ['14310'], '--cwd': ['/tmp'], '--database': ['/tmp/test.db'],
      '--bot-app-id': ['cli_fixture'], '--driver-idle-cpu-action': ['off'], '--idle-timeout-ms': ['1000'], '--cleanup-interval-ms': ['1000'],
      '--lark-app-id': ['cli_fixture'], '--lark-app-secret': ['fixture'], '--lark-receive-id': ['oc_fixture'], '--lark-chat-id': ['oc_fixture'],
      '--lark-receive-id-type': ['chat_id'], '--lark-agent-name': ['fixture'], '--lark-base-url': ['http://127.0.0.1']
    };
    const options = createCliProgram('test').options.map(option => ({ flag: option.long, values: option.required ? values[option.long] : [] }));
    expect(options).toHaveLength(22);
    for (const { flag, values: value } of options) {
      expect(value, flag).toBeDefined();
      for (const prefix of [['agent', 'status'], ['session', 'send', 'text'], ['tool', 'list', '--turn', 'turn-1'], ['plugin-tool', 'list', '--turn', 'turn-1']]) {
        expect(internalAgentRoute(['node', 'internal', ...prefix, flag, ...value!])).toBeUndefined();
        await parity([...prefix, flag, ...value!], { credentials: false });
      }
    }
    await parity(['agent', 'status', '-V'], { credentials: false });
  }, 180_000);

  it.each([
    ['fast route', ['agent', '--turn', 'turn-1', 'status']],
    ['fallback route', ['--agent-turn', 'turn-1', 'group', 'messages']]
  ])('prints an unreadable .env warning once on the %s', async (_label, args) => {
    const result = await parity(args, { dotenv: true, credentials: false });
    expect(result.stderr.match(/警告：无法读取/g)).toHaveLength(1);
  });
});

async function reservedPort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function retryParity(entry: string) {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-relay-retry-'));
  const port = await reservedPort();
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== '/api/relay/sessions/self/send') { response.statusCode = 404; response.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ url: request.url, body: Buffer.concat(chunks).toString(), authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ accepted: true }));
  });
  await new Promise(resolve => setTimeout(resolve, 350));
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  try {
    return await new Promise<{ code: number; stdout: string; stderr: string; requests: RecordedRequest[] }>((resolve, reject) => {
      const child = execFile(process.execPath, [entry, 'session', 'send', 'retry once'], {
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH!, NODE_COMPILE_CACHE: join(dirname(entry), 'compile-cache'), dutydeck_relay_url: `http://127.0.0.1:${port}/api/relay`, dutydeck_relay_token: 'token' },
        timeout: 10_000,
        encoding: 'utf8'
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') { reject(error); return; }
        resolve({ code: error ? error.code as number : 0, stdout, stderr, requests });
      });
      child.stdin!.end();
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

it('retries ECONNREFUSED once available with the same relay request', async () => {
  const full = await retryParity(fullCli);
  const internal = await retryParity(internalCli);
  expect(internal).toEqual(full);
  expect(full.code).toBe(0);
  expect(full.requests).toHaveLength(1);
  expect(full.requests[0]?.body).toBe('{"text":"retry once"}');
}, 30_000);

async function resetParity(entry: string) {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-relay-reset-'));
  let connections = 0;
  const server = createServer((request, response) => {
    if (request.url !== '/api/relay/sessions/self/send') { response.statusCode = 404; response.end(); return; }
    connections += 1;
    request.socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await new Promise<{ code: number; stdout: string; stderr: string; connections: number }>((resolve, reject) => {
      const child = execFile(process.execPath, [entry, 'session', 'send', 'do not repeat'], {
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH!, NODE_COMPILE_CACHE: join(dirname(entry), 'compile-cache'), dutydeck_relay_url: `http://127.0.0.1:${port}/api/relay`, dutydeck_relay_token: 'token' },
        timeout: 10_000,
        encoding: 'utf8'
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') { reject(error); return; }
        resolve({ code: error ? error.code as number : 0, stdout, stderr, connections });
      });
      child.stdin!.end();
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

it('does not retry ECONNRESET', async () => {
  const full = await resetParity(fullCli);
  const internal = await resetParity(internalCli);
  expect(internal).toEqual(full);
  expect(full.code).toBe(3);
  expect(full.connections).toBe(1);
}, 30_000);

async function deferredParity(entry: string) {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-deferred-parity-'));
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== '/api/relay/sessions/self/ask' && request.url !== '/api/relay/sessions/self/deferred-ack') {
      response.statusCode = 404; response.end(); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/deferred-ack')) { response.end('{}'); return; }
    response.end(JSON.stringify({ status: 'deferred', askId: 'ask_deferred', reason: 'waiting for click' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, [entry, 'session', 'ask', 'wait', '--request-id', 'stable-deferred'], {
    cwd: root,
    env: { HOME: root, PATH: process.env.PATH!, NODE_COMPILE_CACHE: join(dirname(entry), 'compile-cache'), dutydeck_relay_url: `http://127.0.0.1:${port}/api/relay`, dutydeck_relay_token: 'token' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('deferred ack not received')), 10_000);
      const check = () => {
        if (requests.includes('/api/relay/sessions/self/deferred-ack')) { clearTimeout(deadline); resolve(); }
        else setTimeout(check, 20);
      };
      check();
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    return { stdout, stderr, requests };
  } finally {
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

it('flushes deferred output and acknowledgement without exiting early', async () => {
  const full = await deferredParity(fullCli);
  const internal = await deferredParity(internalCli);
  expect(internal).toEqual(full);
  expect(full.requests).toEqual(['/api/relay/sessions/self/ask', '/api/relay/sessions/self/deferred-ack']);
  expect(full.stderr).toBe('requestId: stable-deferred\nwaiting for click\n');
}, 30_000);

async function permissionWaitParity(entry: string) {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-permission-wait-'));
  const requests: string[] = [];
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url !== '/api/relay/sessions/self/permission') { response.statusCode = 404; response.end(); return; }
    requests.push(Buffer.concat(chunks).toString());
    response.setHeader('content-type', 'application/json');
    if (requests.length === 1) { response.end(JSON.stringify({ status: 'pending', permissionId: 'permission-1' })); return; }
    await released;
    response.end(JSON.stringify({ status: 'approved' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, [entry, 'session', 'permission-hook'], {
    cwd: root,
    env: { HOME: root, PATH: process.env.PATH!, NODE_COMPILE_CACHE: join(dirname(entry), 'compile-cache'), dutydeck_relay_url: `http://127.0.0.1:${port}/api/relay`, dutydeck_relay_token: 'token' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pnpm test' } }));
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('permission continuation not received')), 10_000);
      const check = () => {
        if (requests.length >= 2) { clearTimeout(deadline); resolve(); }
        else setTimeout(check, 20);
      };
      check();
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(child.exitCode).toBeNull();
    release();
    await new Promise<void>((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error(`permission exit ${code}`))));
    return { stdout, stderr, requests };
  } finally {
    release();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

it('keeps waiting through permission pending and resumes only after the decision', async () => {
  const full = await permissionWaitParity(fullCli);
  const internal = await permissionWaitParity(internalCli);
  expect(internal).toEqual(full);
  expect(full.requests).toHaveLength(2);
  expect(JSON.parse(full.requests[1]!)).toEqual({ permissionId: 'permission-1' });
  expect(JSON.parse(full.stdout).hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
}, 30_000);
