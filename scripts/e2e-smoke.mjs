#!/usr/bin/env node
/**
 * dockmux 端到端冒烟检查
 *
 * 固化 M1 手动验证过的关键路径，可重复执行：
 *   1. 启动 server（临时端口 + 临时数据目录，前台进程，绝不 daemonize）
 *   2. GET /api/agents —— 断言 ACP agent 与 pty-cli agent 都被发现
 *   3. 创建 pty-cli 会话（claude-code）→ 发消息 → SSE 收事件流
 *      断言：收到 thinking/text、最终 completed、session state 变 completed
 *   4. resume 后仍能继续对话：POST /resume → 再发一轮 → 用 SSE 游标确认是新事件
 *      而不是回放（M2 时这条路径全套单测通过、真实环境却完全不可用）
 *   5. 终端 WS /api/terminal/:sessionId 能连上并收到帧
 *   6. 静态 Web UI 可访问
 *   7. 清理：停会话、杀 server、删临时数据目录
 *
 * 两种模式
 *   默认 --mock：用 /tmp 下生成的假 CLI（Node 脚本）冒充 claude，不触碰真实模型，CI 可跑。
 *               通过 DOCKMUX_AGENTS_JSON 覆盖 claude-code agent 的 command 指向假 CLI。
 *   --real     ：用本机真实 `claude` CLI，会真的调用模型、产生费用。必须显式指定。
 *
 * 清理保证
 *   - 所有资源（server 进程、SSE 连接、WS 连接、临时目录）都在 try/finally 里注册到
 *     cleanup 栈，任何一步抛异常都会逆序清理。
 *   - server 先 SIGTERM 后 SIGKILL（超时兜底），并用 detached + process.kill(-pid)
 *     杀整个进程组，避免 PTY 里的 CLI 子进程变孤儿。
 *   - 全局看门狗超时（--timeout，默认 mock 120s / real 300s）到点强制清理并退出 1。
 *   - 进程收到 SIGINT/SIGTERM 时同样走清理。
 *
 * 用法
 *   node scripts/e2e-smoke.mjs                 # mock 模式（默认）
 *   node scripts/e2e-smoke.mjs --real          # 真实 CLI
 *   node scripts/e2e-smoke.mjs --port 14500 --verbose
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SERVER_ENTRY = join(REPO, 'apps/server/dist/cli.js');

// ── 参数 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const REAL = flag('real');
const VERBOSE = flag('verbose');
// 默认端口刻意避开 14310 与 4310：不要撞上开发者本地正在跑的实例
const PORT = Number(value('port', '14387'));
const TIMEOUT_MS = Number(value('timeout', REAL ? '300000' : '120000'));

// 被桥接的 CLI 必须拿干净的鉴权环境：本机 shell 里的这些变量会污染子进程
// （M1 时的真实 bug：daemon 的 ANTHROPIC_BASE_URL 漏进了被桥接的 claude）。
const POLLUTING_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

// ── 输出 ───────────────────────────────────────────────────────────────────
const BASE = `http://127.0.0.1:${PORT}`;
let stepNumber = 0;
const results = [];
const log = (...args) => console.log(...args);
const debug = (...args) => { if (VERBOSE) console.log('   ·', ...args); };
const ok = message => { results.push({ ok: true, message }); log(`   ✓ ${message}`); };
const step = title => { stepNumber += 1; log(`\n[${stepNumber}] ${title}`); };
const assert = (condition, message) => {
  if (!condition) throw new Error(`断言失败：${message}`);
  ok(message);
};

// ── 清理栈 ─────────────────────────────────────────────────────────────────
const cleanups = [];
const onCleanup = (label, fn) => cleanups.push({ label, fn });
let cleaningUp = false;
async function runCleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  log('\n[cleanup] 释放资源');
  // 逆序清理：后创建的先释放
  for (const { label, fn } of [...cleanups].reverse()) {
    try {
      await fn();
      log(`   ✓ ${label}`);
    } catch (error) {
      log(`   ! ${label} 清理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ── HTTP 小工具 ────────────────────────────────────────────────────────────
async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* 非 JSON 响应（静态资源）保留 text */ }
  return { status: response.status, headers: response.headers, json, text };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(label, predicate, { timeoutMs = 30_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待「${label}」超时（${timeoutMs}ms）${last instanceof Error ? `：${last.message}` : ''}`);
}

// ── 假 CLI ─────────────────────────────────────────────────────────────────
/**
 * 生成假 claude CLI。它必须同时满足 pty-cli 驱动的两条链路，否则会话到不了 completed：
 *   1. 屏幕流：先打印 readyPattern（❯）解除 idle 闸门，回答完再打印
 *      completionPattern（`✳ Worked for 1s`）让 idle-detector 判定一轮结束。
 *   2. transcript：把 Claude 格式 JSONL 写到 <CLAUDE_CONFIG_DIR>/projects/<key>/<uuid>.jsonl，
 *      驱动 tail 这个文件才会产生结构化的 thinking / tool_call / text 事件。
 *      只有屏幕流的话事件全是 raw_terminal，runtime 会因「未返回最终输出」把任务判 failed。
 */
function writeMockCli(binDir, claudeDataDir) {
  const path = join(binDir, 'mock-claude');
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

// 驱动会剥离子进程的 CLAUDE_* 环境变量，所以数据目录经 agent.env 用别名传进来
const dataDir = process.env.MOCK_CLAUDE_DATA_DIR;
// fresh 形态的 argv 是 --session-id <id>，resume 形态是 --resume <id>。
// 两种都要落到**同一个** jsonl：resume 后 transcript tailer 还在 tail 原文件，
// 换个文件名等于跟丢，第二轮永远收不到结构化事件。
const freshIndex = process.argv.indexOf('--session-id');
const resumeIndex = process.argv.indexOf('--resume');
const resumed = resumeIndex >= 0;
const sessionArg = freshIndex >= 0
  ? process.argv[freshIndex + 1]
  : (resumed ? process.argv[resumeIndex + 1] : undefined);
const projectKey = realpathSync(process.cwd()).replace(/[^A-Za-z0-9-]/g, '-');
const dir = join(dataDir, 'projects', projectKey);
mkdirSync(dir, { recursive: true });
const file = join(dir, \`\${sessionArg ?? 'mock'}.jsonl\`);
const write = entry => appendFileSync(file, JSON.stringify(entry) + '\\n');

// readyPattern：❯ —— 不打印它，idle-detector 永远不会判定空闲
process.stdout.write((resumed ? 'Mock Claude CLI (resumed)' : 'Mock Claude CLI') + '\\r\\n\\u276f ');

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (!/[\\r\\n]/.test(buffer)) return;
  // 适配器用 bracketed paste 包裹 prompt，这里剥掉标记
  const prompt = buffer.replace(/\\u001b\\[20[01]~/g, '').replace(/[\\r\\n]+/g, ' ').trim();
  buffer = '';
  if (!prompt) return;
  process.stdout.write('\\r\\nworking\\r\\n');
  setTimeout(() => {
    write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'mock thinking block' }] } });
    write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_mock_1', name: 'Bash', input: { command: 'echo mock' } }] } });
    write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_mock_1', content: 'mock' }] } });
    // 回复带上形态标记：resume 后的那一轮必须由**重 spawn 出来的**进程产出，
    // 拿不到这个标记就说明第二轮读到的其实是第一轮的回放。
    write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (resumed ? 'MOCK_RESUMED: ' : 'MOCK_REPLY: ') + prompt }] } });
    // completionPattern：✳ Worked for Ns
    process.stdout.write('\\r\\n\\u2733 Worked for 1s\\r\\n\\u276f ');
  }, 300);
});
process.stdin.resume();
`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

// ── SSE ────────────────────────────────────────────────────────────────────
/**
 * 手写 SSE 客户端（Node 无内建 EventSource，且这里要断言 id:/event:/data: 的线格式）。
 * 返回 { events, done, close, cursor, since }：
 *  - events 持续累积，done 在收到**第一个** completed 后 resolve（步骤 3 用）
 *  - cursor()/since() 按 sequence 切分「新事件 vs 已有事件」，供 resume 步骤跨轮判定
 *
 * 为什么需要游标：resume 之后再发一轮，流里已经躺着第一轮的全部事件。
 * 只看「有没有 text」会把上一轮的输出当成本轮的产出——这个假象真的骗过我一次，
 * 当时脚本报成功，实际第二轮的 send 返回的是 409，读到的全是回放。
 */
function openSseStream(sessionId) {
  const events = [];
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  let settled = false;

  const req = http.get(`${BASE}/api/sessions/${sessionId}/stream?after=0`, response => {
    if (response.statusCode !== 200) {
      settled = true;
      rejectDone(new Error(`SSE 返回 ${response.statusCode}`));
      response.resume();
      return;
    }
    response.setEncoding('utf8');
    let buffer = '';
    response.on('data', chunk => {
      buffer += chunk;
      let index;
      // SSE 以空行分帧
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.startsWith(':')) continue; // 注释帧（: connected / : heartbeat）
        const type = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!type || !data) continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        events.push({ type, event: parsed });
        debug(`sse ${type}`, JSON.stringify(parsed.data).slice(0, 120));
        if (type === 'completed' && !settled) { settled = true; resolveDone(events); }
      }
    });
    response.on('end', () => { if (!settled) { settled = true; rejectDone(new Error('SSE 流在收到 completed 前结束')); } });
  });
  req.on('error', error => { if (!settled) { settled = true; rejectDone(error); } });

  const cursor = () => events.reduce((max, item) => Math.max(max, item.event.sequence ?? 0), 0);
  return {
    events,
    done,
    cursor,
    /** 严格晚于 `at` 的事件——即某个时间点之后真正新产生的那些。 */
    since: at => events.filter(item => (item.event.sequence ?? 0) > at),
    close: () => { try { req.destroy(); } catch { /* 已关闭 */ } }
  };
}

// ── WS ─────────────────────────────────────────────────────────────────────

/** 终端 WS：ws 包装在 apps/server 的依赖里，从那儿解析 */
function loadWebSocket() {
  const require = createRequire(join(REPO, 'apps/server/package.json'));
  return require('ws').WebSocket;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main() {
  log(`dockmux e2e smoke — ${REAL ? 'REAL（调用真实 CLI 与模型）' : 'MOCK（假 CLI，不触碰模型）'}`);
  log(`端口 ${PORT} · 全局超时 ${TIMEOUT_MS}ms`);

  // 临时数据目录（DB、假 CLI、假 CLAUDE_CONFIG_DIR 全在里面，清理时整棵删掉）
  const dataDir = mkdtempSync(join(tmpdir(), 'dockmux-smoke-'));
  onCleanup(`删除临时目录 ${dataDir}`, () => rmSync(dataDir, { recursive: true, force: true }));
  const binDir = join(dataDir, 'bin');
  const claudeDataDir = join(dataDir, 'claude');
  const workspace = join(dataDir, 'workspace');
  for (const dir of [binDir, claudeDataDir, workspace]) mkdirSync(dir, { recursive: true });

  // ── 1. 启动 server ───────────────────────────────────────────────────────
  step('启动 server');
  const serverEnv = { ...process.env };
  for (const key of POLLUTING_ENV) delete serverEnv[key];
  // 刻意**不**在这里设 CLAUDE_CONFIG_DIR。
  //
  // 曾经这么做过，而且是靠一个 bug 才生效的：tailer 那时读的是 daemon 自己的
  // process.env，所以 daemon 上设一下就够了。真实形态完全不是这样——driver 的
  // mergedEnv 会把 CLAUDE_* 从子进程剥掉，CLI 实际写的是它自己 env 指向的目录。
  // 那个 bug 修掉后（tailer 改读子进程 env），这里再设就没有任何作用了。
  //
  // 正确通道是下面 agent.env：它在剥离之后合并，既真的送进 CLI、也正是
  // tailer 现在解析的那份 env。
  serverEnv.NODE_ENV = 'production';

  // MOCK 模式的 CLI 数据目录：假 CLI 没有登录概念，隔离到临时目录即可。
  //
  // REAL 模式不能这么做——claude 的**凭证和 transcript 在同一个目录**，隔离
  // transcript 就等于隔离登录状态，CLI 会停在「Select login method」页等人选。
  // （试过隔离 HOME 并播种配置，同样卡住，只是换成 "Security notes … Press
  // Enter to continue" 那一屏；`claude -p` 非交互模式正常，但 dockmux 用的是
  // TUI 形态，两条路径不共用这些一次性状态。）
  // 所以 REAL 用开发者真实的配置目录，跑完把自己产生的会话文件删掉。
  const bridgedCliEnv = REAL ? {} : { CLAUDE_CONFIG_DIR: claudeDataDir };

  if (!REAL) {
    const mockPath = writeMockCli(binDir, claudeDataDir);
    // 覆盖内置 claude-code agent 的 command 指向假 CLI。
    // id 必须仍是 'claude-code'：pty 驱动工厂按 agent.id 找适配器，未知 id 会抛错。
    // 给 version 是为了跳过 cliVersion() 的三次 spawnSync 探测。
    serverEnv.DOCKMUX_AGENTS_JSON = JSON.stringify([{
      id: 'claude-code',
      name: 'Mock Claude',
      command: mockPath,
      args: [],
      protocol: 'pty-cli',
      cwd: workspace,
      // agent.env 在剥离之后合并，是把变量送进被桥接 CLI 的唯一通道
      env: { ...bridgedCliEnv, MOCK_CLAUDE_DATA_DIR: claudeDataDir },
      permissionMode: 'full-trust',
      timeout: 600,
      capabilities: { pause: false, resume: true },
      builtin: false,
      version: 'mock-1.0'
    }]);
    debug('假 CLI', mockPath);
  } else {
    // REAL 模式：真实 claude，用开发者自己的配置目录（凭证在那儿，见上面的说明）。
    // 会话历史因此会写进 ~/.claude/projects/<workspace 派生的 key>/——但 workspace
    // 是本次跑独有的临时目录，所以那个 project 目录也是本次独有的，清理时整个删掉，
    // 开发者真实项目的历史一个字节都不受影响。
    onCleanup('删除真实 CLI 写下的会话历史', () => {
      // claude 用 realpath 后把非字母数字替换成 '-' 作为 project key，
      // 与 packages/pty-driver 的 realCwd()/claudeProjectDir() 同一套规则。
      const projectKey = realpathSync(workspace).replace(/[^A-Za-z0-9-]/g, '-');
      rmSync(join(homedir(), '.claude', 'projects', projectKey), { recursive: true, force: true });
    });
    serverEnv.DOCKMUX_AGENTS_JSON = JSON.stringify([{
      id: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      args: [],
      protocol: 'pty-cli',
      cwd: workspace,
      env: bridgedCliEnv,
      permissionMode: 'full-trust',
      timeout: 600,
      capabilities: { pause: false, resume: true },
      builtin: false
    }]);
    debug('真实 CLI 的工作目录', workspace);
  }

  const server = spawn(process.execPath, [
    SERVER_ENTRY,
    '--local-only',            // 绑 127.0.0.1，同时让鉴权中间件整体放行
    '--port', String(PORT),
    '--cwd', workspace,
    '--database', join(dataDir, 'dockmux.db'),
    '--no-lark-listen'         // 不去连飞书
  ], {
    cwd: workspace,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true             // 独立进程组，方便连 PTY 子进程一起杀
  });

  const serverLog = [];
  server.stdout.on('data', chunk => { serverLog.push(String(chunk)); if (VERBOSE) process.stdout.write(`   | ${chunk}`); });
  server.stderr.on('data', chunk => { serverLog.push(String(chunk)); if (VERBOSE) process.stderr.write(`   | ${chunk}`); });
  let serverExit;
  server.on('exit', code => { serverExit = code; });

  onCleanup('停止 server', async () => {
    if (serverExit !== undefined) return;
    // 杀整个进程组（-pid）：PTY 里的 CLI 是 server 的子进程，单杀 server 会留孤儿
    try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* 已退出 */ } }
    const deadline = Date.now() + 8_000;
    while (serverExit === undefined && Date.now() < deadline) await sleep(100);
    if (serverExit === undefined) {
      try { process.kill(-server.pid, 'SIGKILL'); } catch { try { server.kill('SIGKILL'); } catch { /* 已退出 */ } }
      await sleep(500);
    }
  });

  await waitFor('server 就绪', async () => {
    if (serverExit !== undefined) throw new Error(`server 提前退出（code ${serverExit}）：\n${serverLog.join('')}`);
    const response = await request('GET', '/health');
    return response.status === 200 && response.json?.ok === true;
  }, { timeoutMs: 45_000 });
  ok(`GET /health 返回 {ok:true}（端口 ${PORT}）`);

  // ── 2. agent 发现 ────────────────────────────────────────────────────────
  step('拉取 agent 列表');
  const agentsResponse = await request('GET', '/api/agents');
  assert(agentsResponse.status === 200, 'GET /api/agents 返回 200');
  const agents = agentsResponse.json ?? [];
  const acpAgents = agents.filter(agent => agent.protocol === 'acp');
  const ptyAgents = agents.filter(agent => agent.protocol === 'pty-cli');
  debug('agents', agents.map(agent => `${agent.id}:${agent.protocol}`).join(', '));
  assert(acpAgents.length > 0, `发现 ACP agent ${acpAgents.length} 个：${acpAgents.map(a => a.id).join(', ')}`);
  assert(ptyAgents.length > 0, `发现 pty-cli agent ${ptyAgents.length} 个：${ptyAgents.map(a => a.id).join(', ')}`);
  const claudeCode = ptyAgents.find(agent => agent.id === 'claude-code');
  assert(Boolean(claudeCode), 'pty-cli 列表里有 claude-code');
  if (!REAL) assert(claudeCode.command.endsWith('mock-claude'), 'mock 模式下 claude-code 指向假 CLI（未使用真实 claude）');

  // ── 3. pty-cli 会话 + SSE ────────────────────────────────────────────────
  step('创建 pty-cli 会话并通过 SSE 收事件流');
  const created = await request('POST', '/api/sessions', { agentId: 'claude-code', cwd: workspace });
  assert(created.status === 200, `POST /api/sessions 返回 200（实际 ${created.status}）`);
  const session = created.json;
  assert(typeof session?.id === 'string' && session.id.startsWith('ses_'), `会话已创建：${session?.id}`);
  assert(session.protocol === 'pty-cli' || claudeCode.protocol === 'pty-cli', '会话走 pty-cli 协议');

  onCleanup(`关闭会话 ${session.id}`, async () => {
    const stopped = await request('POST', `/api/sessions/${session.id}/stop`);
    if (stopped.status !== 200) throw new Error(`stop 返回 ${stopped.status}`);
  });

  // SSE 必须先连上再发消息，否则 completed 可能在订阅前就发出去了
  // （?after=0 会补发历史事件，这里双保险）
  const stream = openSseStream(session.id);
  onCleanup('关闭 SSE 连接', () => stream.close());
  await sleep(500);

  const prompt = REAL ? '回复一句话：smoke ok' : 'smoke test prompt';
  const sent = await request('POST', `/api/sessions/${session.id}/send`, { prompt, mode: 'queue' });
  assert(sent.status === 202, `POST /send 返回 202 accepted（实际 ${sent.status}）`);
  assert(sent.json?.task?.id?.startsWith('task_'), `任务已入队：${sent.json?.task?.id}`);

  const sseTimeout = REAL ? Math.min(TIMEOUT_MS - 30_000, 180_000) : 60_000;
  const events = await Promise.race([
    stream.done,
    sleep(sseTimeout).then(() => { throw new Error(`SSE 未在 ${sseTimeout}ms 内收到 completed，已收到：${stream.events.map(e => e.type).join(', ') || '（无）'}`); })
  ]);

  const types = events.map(item => item.type);
  debug('事件序列', types.join(' → '));
  assert(types.includes('thinking') || types.includes('text'), `收到 thinking 或 text 事件（实际含：${[...new Set(types)].join(', ')}）`);
  assert(types.includes('completed'), '收到 completed 事件');
  // 线格式：SSE 帧必须带 sequence（作为 id:）与合法 type
  const completedEvent = events.find(item => item.type === 'completed').event;
  assert(typeof completedEvent.sequence === 'number' && completedEvent.sequence > 0, 'completed 事件带 sequence（SSE id: 游标可用）');

  const finalState = await waitFor('session state 变 completed', async () => {
    const current = await request('GET', `/api/sessions/${session.id}`);
    return current.json?.state === 'completed' ? current.json : undefined;
  }, { timeoutMs: 20_000 });
  assert(finalState.state === 'completed', `会话 state = completed`);

  if (!REAL) {
    const assistantText = events.filter(item => item.type === 'text').map(item => item.event.data?.text ?? '').join('');
    assert(assistantText.includes('MOCK_REPLY'), '假 CLI 的回复经 transcript 解析成 text 事件');
  }

  // ── 4. resume 后续接可用 ─────────────────────────────────────────────────
  // 为什么值得单列一步：M2 时全套单测通过，resume 在真实环境里却完全不可用——
  // respawn 会 kill 旧后端，那次 SIGHUP(129) 被当成 agent 崩溃上报，会话立刻
  // 判 failed，之后每个 send 都是 409。mock CLI 的单测发现不了，只有走完整
  // HTTP + PTY 链路才暴露。
  step('resume 后仍能继续对话');
  const beforeResume = stream.cursor();
  const resumed = await request('POST', `/api/sessions/${session.id}/resume`);
  assert(resumed.status === 200 || resumed.status === 202, `POST /resume 返回 2xx（实际 ${resumed.status}）`);

  // 关键：resume 返回 200 之后，failed 才在下一个 tick 悄悄写进去。
  // 立刻断言"成功"会漏掉整个 bug——必须等一会儿再查状态。
  await sleep(3_000);
  const afterResume = await request('GET', `/api/sessions/${session.id}`);
  assert(afterResume.json?.state !== 'failed',
    `resume 3 秒后 state 不是 failed（实际 ${afterResume.json?.state}）`);
  const resumeErrors = stream.since(beforeResume).filter(item => item.type === 'error');
  assert(resumeErrors.length === 0,
    `resume 未产生 error 事件（实际 ${JSON.stringify(resumeErrors.map(item => item.event.data?.message))}）`);

  const beforeSecondTurn = stream.cursor();
  const secondPrompt = REAL ? '再回复一句话：resume ok' : 'second turn after resume';
  const secondSent = await request('POST', `/api/sessions/${session.id}/send`, { prompt: secondPrompt, mode: 'queue' });
  // 这条断言是当初漏掉的那条：send 返回 409 INVALID_STATE，而脚本只看流里
  // "有 text" 就报成功——读到的其实全是第一轮的回放。
  assert(secondSent.status === 202, `resume 后 POST /send 返回 202（实际 ${secondSent.status}）`);

  const secondTurn = await waitFor('resume 后第二轮的 completed', async () => {
    const fresh = stream.since(beforeSecondTurn);
    return fresh.some(item => item.type === 'completed') ? fresh : undefined;
  }, { timeoutMs: REAL ? 150_000 : 60_000 });
  assert(secondTurn.some(item => item.type === 'text' || item.type === 'thinking'),
    `第二轮有实质输出（${secondTurn.length} 条新事件，全部 sequence > ${beforeSecondTurn}）`);

  if (!REAL) {
    const secondText = secondTurn.filter(item => item.type === 'text').map(item => item.event.data?.text ?? '').join('');
    // MOCK_RESUMED 只有带 --resume 起来的进程会写：拿到它才证明第二轮真的
    // 由 respawn 出来的新进程产出，而不是旧事件被重放。
    assert(secondText.includes('MOCK_RESUMED'),
      `第二轮由 --resume 形态的进程产出（实际前 120 字：${secondText.slice(0, 120)}）`);
  }

  // ── 5. 终端 WS ───────────────────────────────────────────────────────────
  step('连接终端 WebSocket');
  const WebSocketImpl = loadWebSocket();
  const frames = await new Promise((resolveFrames, rejectFrames) => {
    const socket = new WebSocketImpl(`ws://127.0.0.1:${PORT}/api/terminal/${encodeURIComponent(session.id)}`);
    const received = [];
    const finish = error => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* 已关闭 */ }
      error ? rejectFrames(error) : resolveFrames(received);
    };
    const timer = setTimeout(() => finish(received.length ? undefined : new Error('WS 20s 内没有收到任何帧')), 20_000);
    socket.on('open', () => {
      debug('ws 已连接');
      // 服务端连接时不主动推首帧，需要戳一下 PTY 才有输出
      socket.send(JSON.stringify({ type: 'input', data: '\r' }));
    });
    socket.on('message', raw => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      received.push(frame);
      debug('ws frame', frame.type);
      if (frame.type === 'data') finish();
    });
    socket.on('unexpected-response', (_req, response) => finish(new Error(`WS 升级被拒：HTTP ${response.statusCode}`)));
    socket.on('error', error => finish(error));
  });
  assert(frames.length > 0, `终端 WS 连接成功并收到 ${frames.length} 帧`);
  assert(frames.some(frame => frame.type === 'data'), 'WS 收到 data 帧（PTY 输出已代理到前端）');

  // ── 6. 静态 Web UI ───────────────────────────────────────────────────────
  step('访问静态 Web UI');
  const index = await request('GET', '/');
  assert(index.status === 200, 'GET / 返回 200');
  assert((index.headers.get('content-type') ?? '').includes('text/html'), 'GET / 是 text/html');
  assert(index.text.includes('<div id="root"'), 'index.html 含 React 挂载点 #root');
  // API 与静态资源的分流：/api/* 下的未知路径必须 404 JSON，不能回落到 index.html
  const missingApi = await request('GET', '/api/definitely-not-a-route');
  assert(missingApi.status === 404 && missingApi.json?.error?.code === 'NOT_FOUND', '未知 /api/* 路径返回 404 JSON（未被 SPA 回落吞掉）');
}

// ── 入口 ───────────────────────────────────────────────────────────────────
let exitCode = 0;
const watchdog = setTimeout(() => {
  log(`\n✗ 全局超时（${TIMEOUT_MS}ms），强制清理`);
  exitCode = 1;
  runCleanup().finally(() => process.exit(1));
}, TIMEOUT_MS);
watchdog.unref();

const onSignal = signal => { log(`\n收到 ${signal}，清理后退出`); runCleanup().finally(() => process.exit(130)); };
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

try {
  await main();
  log(`\n✓ 冒烟通过：${results.length} 项断言全部成立`);
} catch (error) {
  exitCode = 1;
  log(`\n✗ 冒烟失败：${error instanceof Error ? error.message : String(error)}`);
  if (VERBOSE && error instanceof Error && error.stack) log(error.stack);
} finally {
  clearTimeout(watchdog);
  await runCleanup();
}
process.exit(exitCode);
