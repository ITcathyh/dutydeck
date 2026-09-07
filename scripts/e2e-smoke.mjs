#!/usr/bin/env node
/**
 * dockmux 端到端冒烟检查
 *
 * 固化发布验收中的关键路径，可重复执行：
 *   1. 启动 server（临时端口 + 临时数据目录，前台进程，绝不 daemonize）
 *   2. GET /api/agents —— 断言 ACP agent 与 pty-cli agent 都被发现
 *   3. 真实 Chromium 打开首页，验证创建任务 / 绑定 Bot 主入口，
 *      并通过页面创建、执行一个 mock Agent 任务
 *   4. 创建 pty-cli 会话（claude-code）→ 发消息 → SSE 收事件流
 *      断言：收到 thinking/text、最终 completed、session state 变 completed
 *   5. resume 后仍能继续对话：POST /resume → 再发一轮 → 用 SSE 游标确认是新事件
 *      而不是历史回放，避免单测通过但真实环境不可用
 *   6. 终端 WS /api/terminal/:sessionId 能连上并收到帧
 *   7. 静态 Web UI 可访问
 *   8. 清理：关 Chromium、停会话、杀 server、删临时数据目录
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
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { chromium } from '@playwright/test';

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
// 防止 daemon 的 ANTHROPIC_BASE_URL 意外泄漏进被桥接的 Claude。
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

/** 文案可以微调，但产品主入口必须是浏览器可见、可点的语义化按钮。 */
async function waitForVisibleLocator(label, factories, timeoutMs = 15_000) {
  return waitFor(label, async () => {
    for (const factory of factories) {
      const locator = factory().first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    return undefined;
  }, { timeoutMs, intervalMs: 100 });
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
// 正确聚合整轮输入后，首条结构化输出会与 completion 很接近；预先创建文件，
// 让 transcript tailer 在发送 prompt 前就能订阅，避免把最终输出错过成 raw-only。
appendFileSync(file, '');

// readyPattern：❯ —— 不打印它，idle-detector 永远不会判定空闲
process.stdout.write((resumed ? 'Mock Claude CLI (resumed)' : 'Mock Claude CLI') + '\\r\\n\\u276f ');

let buffer = '';
let composedPrompt = '';
let bracketedPaste = false;
let turn = 0;
const bracketedPasteStart = '\\u001b[200~';
const bracketedPasteEnd = '\\u001b[201~';

const submitPrompt = rawPrompt => {
  const prompt = rawPrompt.trim();
  if (!prompt) return;
  const currentTurn = ++turn;
  process.stdout.write('\\r\\nworking\\r\\n');
  setTimeout(() => {
    write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'mock thinking block' }] } });
    write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_mock_1', name: 'Bash', input: { command: 'echo mock' } }] } });
    write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_mock_1', content: 'mock' }] } });
    // persistent tmux 优先续用存活 pane；只有进程不存在时才以 --resume 重启。
    // 用独立标记区分两条合法路径，也让 smoke 能证明第二轮不是历史回放。
    const marker = resumed ? 'MOCK_RESUMED' : currentTurn > 1 ? 'MOCK_CONTINUED' : 'MOCK_REPLY';
    write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: marker + ': ' + prompt }] } });
    // completionPattern：✳ Worked for Ns
    process.stdout.write('\\r\\n\\u2733 Worked for 1s\\r\\n\\u276f ');
  }, 300);
};

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    if (bracketedPaste) {
      const pasteEnd = buffer.indexOf(bracketedPasteEnd);
      if (pasteEnd < 0) return;
      composedPrompt += buffer.slice(0, pasteEnd);
      buffer = buffer.slice(pasteEnd + bracketedPasteEnd.length);
      bracketedPaste = false;
      continue;
    }

    const pasteStart = buffer.indexOf(bracketedPasteStart);
    const lineBreak = /[\\r\\n]/.exec(buffer);
    if (pasteStart >= 0 && (!lineBreak || pasteStart < lineBreak.index)) {
      composedPrompt += buffer.slice(0, pasteStart);
      buffer = buffer.slice(pasteStart + bracketedPasteStart.length);
      bracketedPaste = true;
      continue;
    }
    if (!lineBreak) return;

    composedPrompt += buffer.slice(0, lineBreak.index);
    const delimiter = lineBreak[0];
    buffer = buffer.slice(lineBreak.index + delimiter.length);
    // 同一个 Enter 可能以 CRLF 到达，只消费配对的第二个字节。
    if ((delimiter === '\\r' && buffer.startsWith('\\n')) || (delimiter === '\\n' && buffer.startsWith('\\r'))) {
      buffer = buffer.slice(1);
    }
    // tmux 下 Claude family 用「反斜杠 + Enter」表达 composer 软换行；
    // 这里只累积，最后一个没有反斜杠的 Enter 才算真正提交一轮。
    if (composedPrompt.endsWith('\\\\')) {
      composedPrompt = composedPrompt.slice(0, -1) + '\\n';
      continue;
    }
    const prompt = composedPrompt;
    composedPrompt = '';
    submitPrompt(prompt);
  }
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
  assert(existsSync(join(REPO, 'apps/server/dist/agents/env-launcher.mjs')), 'production build packages the ACP environment launcher');

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
    '--local-only',            // 绑 127.0.0.1；免 token，但仍校验 loopback Host/Origin
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
  if (!REAL) {
    assert(claudeCode.name === 'Mock Claude' && claudeCode.version === 'mock-1.0',
      'mock Agent 的公开名称与版本已生效（未使用真实 claude）');
  }
  const leakedAgentFields = ['command', 'args', 'cwd', 'env', 'systemPrompt', 'reasoningEffort', 'timeout', 'capabilities', 'builtin']
    .filter(field => Object.hasOwn(claudeCode, field));
  assert(leakedAgentFields.length === 0,
    `公开 Agent 列表不泄露启动配置（实际泄露：${leakedAgentFields.join(', ') || '无'}）`);

  // ── 3. 浏览器产品旅程 ──────────────────────────────────────────────────
  step('用真实 Chromium 走通首次使用、Bot 绑定入口与任务创建');
  let browser = await chromium.launch({ headless: true });
  onCleanup('关闭 Chromium', async () => {
    if (!browser) return;
    await browser.close();
    browser = undefined;
  });

  let browserSessionId;
  onCleanup('关闭浏览器创建的任务运行', async () => {
    if (!browserSessionId) return;
    const stopped = await request('POST', `/api/sessions/${browserSessionId}/stop`);
    if (stopped.status !== 200) throw new Error(`stop 返回 ${stopped.status}`);
    browserSessionId = undefined;
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on('pageerror', error => debug('browser pageerror', error.message));
  page.on('requestfailed', failed => debug('browser requestfailed', failed.method(), failed.url(), failed.failure()?.errorText));
  const productResponses = [];
  page.on('response', response => productResponses.push(response));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ state: 'visible', timeout: 20_000 });

  // 首屏上段是飞书 Bot 概览：飞书 Bot 是 agent 交互核心，dashboard 先回答「Bot 能不能收到我的话」。
  const botOverview = page.getByRole('complementary', { name: '协作入口' });
  await botOverview.waitFor({ state: 'visible', timeout: 20_000 });
  // 未配置 Bot 时必须给出可执行的飞书使用指引，而不是只说「尚未配置」。
  await botOverview.getByRole('heading', { name: '尚未配置飞书机器人' }).waitFor({ state: 'visible', timeout: 20_000 });
  const botGuide = (await botOverview.textContent()) ?? '';
  for (const hint of ['私聊', '@机器人', '/help']) {
    assert(botGuide.includes(hint), `Bot 概览说明绑定后如何在飞书使用（缺少「${hint}」）`);
  }
  // 无 Bot 时不得出现任何「已接入 / 监听已启动」类声明。
  for (const lie of ['已接入', '监听已启动']) {
    assert(!botGuide.includes(lie), `无 Bot 时不谎报接入状态（出现了「${lie}」）`);
  }

  const firstUseHeading = page.getByRole('heading', { name: '从第一个明确目标开始' });
  await firstUseHeading.waitFor({ state: 'visible', timeout: 20_000 });
  assert(await firstUseHeading.isVisible(), '首次使用空状态说明如何开始第一个任务');

  const workbenchNavigation = page.getByRole('complementary', { name: 'Dockmux 工作台导航' });
  const createTaskEntry = await waitForVisibleLocator('首页创建任务入口', [
    () => workbenchNavigation.getByRole('button', { name: '创建任务', exact: true }),
    () => page.getByRole('button', { name: '创建第一个任务', exact: true })
  ]);
  // 绑定入口现在是首屏 Bot 概览的主操作，且同屏只有一颗（侧栏那颗叫「飞书接入」）。
  const bindBotEntry = botOverview.getByRole('button', { name: '绑定飞书 Bot', exact: true });
  assert(await bindBotEntry.count() === 1, '首屏「绑定飞书 Bot」主操作唯一，不与其他入口重名');
  assert(await createTaskEntry.isEnabled(), 'Web 创建任务次级入口可见且可用');
  assert(await bindBotEntry.isEnabled(), '首页「绑定飞书 Bot」主操作可见且可用');

  await bindBotEntry.click();
  const bindBotWizard = page.getByRole('dialog', { name: /绑定.*Bot|飞书机器人/ });
  await bindBotWizard.waitFor({ state: 'visible', timeout: 20_000 });
  assert(await bindBotWizard.getByRole('button', { name: '新增机器人', exact: true }).isVisible(),
    '绑定 Bot 向导已打开，并提供新增机器人入口');
  await bindBotWizard.getByRole('button', { name: '关闭', exact: true }).click();
  await bindBotWizard.waitFor({ state: 'hidden' });

  await createTaskEntry.click();
  const createTaskForm = page.getByRole('dialog', { name: /创建.*任务/ });
  await createTaskForm.waitFor({ state: 'visible' });
  const browserPrompt = REAL ? '回复一句话：browser smoke ok' : 'browser product journey';
  await createTaskForm.getByLabel('任务目标').fill(browserPrompt);

  const agentSelect = createTaskForm.locator('button[aria-haspopup="listbox"]').first();
  await agentSelect.click();
  const browserAgentName = REAL ? 'Claude Code' : 'Mock Claude';
  // Option 的 accessible name 还会包含版本号，因此按 Agent 名称子串匹配。
  await page.getByRole('option', { name: browserAgentName }).click();
  assert((await agentSelect.textContent())?.includes(browserAgentName),
    `创建任务向导已选择 ${browserAgentName}`);
  const fullTrustConfirmation = createTaskForm.getByRole('checkbox');
  if (await fullTrustConfirmation.isVisible().catch(() => false)) {
    await fullTrustConfirmation.check();
    assert(await fullTrustConfirmation.isChecked(), `已在浏览器确认 ${browserAgentName} 的完全信任权限`);
  }

  await createTaskForm.getByRole('button', { name: '创建并执行', exact: true }).click();
  const browserCreateResponse = await waitFor('浏览器发出创建任务请求', () => productResponses.find(response => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === '/api/sessions';
  }), { timeoutMs: 30_000, intervalMs: 50 });
  assert(browserCreateResponse.status() === 200,
    `浏览器 POST /api/sessions 返回 200（实际 ${browserCreateResponse.status()}）`);
  const browserSession = await browserCreateResponse.json();
  assert(typeof browserSession?.id === 'string' && browserSession.id.startsWith('ses_'),
    `浏览器创建了真实任务运行：${browserSession?.id}`);
  browserSessionId = browserSession.id;

  const browserSendResponse = await waitFor('浏览器派发任务目标', () => productResponses.find(response => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === `/api/sessions/${browserSessionId}/send`;
  }), { timeoutMs: 30_000, intervalMs: 50 });
  assert(browserSendResponse.status() === 202,
    `浏览器 POST /send 返回 202（实际 ${browserSendResponse.status()}）`);
  await page.waitForURL(url => url.pathname === `/sessions/${browserSessionId}`, { timeout: 20_000 });
  await page.getByLabel('已完成', { exact: true }).waitFor({ state: 'visible', timeout: REAL ? 150_000 : 60_000 });
  if (!REAL) {
    try {
      await page.getByText(/MOCK_REPLY:/).last().waitFor({ state: 'visible', timeout: 20_000 });
    } catch (error) {
      const visibleText = (await page.locator('body').innerText()).slice(-2_000);
      throw new Error(`浏览器任务已完成但最终回复未展示。页面末尾文本：\n${visibleText}`, { cause: error });
    }
    ok('Mock Agent 的最终回复已展示在真实浏览器任务详情中');
  }

  await browser.close();
  browser = undefined;
  const stoppedBrowserSession = await request('POST', `/api/sessions/${browserSessionId}/stop`);
  assert(stoppedBrowserSession.status === 200, `浏览器任务运行清理成功（实际 ${stoppedBrowserSession.status}）`);
  browserSessionId = undefined;

  // ── 4. pty-cli 会话 + SSE ────────────────────────────────────────────────
  step('创建 pty-cli 任务运行并通过 SSE 收事件流');
  const created = await request('POST', '/api/sessions', { agentId: 'claude-code', cwd: workspace });
  assert(created.status === 200, `POST /api/sessions 返回 200（实际 ${created.status}）`);
  const session = created.json;
  assert(typeof session?.id === 'string' && session.id.startsWith('ses_'), `任务运行已创建：${session?.id}`);
  assert(session.protocol === 'pty-cli' || claudeCode.protocol === 'pty-cli', '任务运行走 pty-cli 协议');

  onCleanup(`关闭任务运行 ${session.id}`, async () => {
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

  const finalState = await waitFor('任务运行状态变为 completed', async () => {
    const current = await request('GET', `/api/sessions/${session.id}`);
    return current.json?.state === 'completed' ? current.json : undefined;
  }, { timeoutMs: 20_000 });
  assert(finalState.state === 'completed', '任务运行 state = completed');

  if (!REAL) {
    const assistantText = events.filter(item => item.type === 'text').map(item => item.event.data?.text ?? '').join('');
    assert(assistantText.includes('MOCK_REPLY'), '假 CLI 的回复经 transcript 解析成 text 事件');
  }

  // ── 5. resume 后续接可用 ─────────────────────────────────────────────────
  // 单列真实 resume：这类供应商协议差异不能只靠 mock 单测证明。
  // persistent tmux 的主路径是 reattach 仍存活的 pane、续用同一进程；若 pane
  // 中的进程已不存在，则允许以 --resume respawn。两种路径都必须保持会话可用、
  // 产生严格晚于游标的新事件，不能把第一轮历史回放误判成第二轮成功。
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
    const continuation = [
      { marker: 'MOCK_CONTINUED', path: 'persistent pane 中的存活进程续跑' },
      { marker: 'MOCK_RESUMED', path: '进程缺失后以 --resume respawn' }
    ].find(candidate => secondText.includes(`${candidate.marker}: ${secondPrompt}`));
    assert(Boolean(continuation),
      `第二轮包含新 prompt，并走 persistent continuation 或 --resume respawn（实际前 160 字：${secondText.slice(0, 160)}）`);
    ok(`resume 采用合法路径：${continuation.path}`);
  }

  // ── 6. 终端 WS ───────────────────────────────────────────────────────────
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

  // ── 7. 静态 Web UI ───────────────────────────────────────────────────────
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
