/**
 * e2e 冒烟脚本的共享基建。
 *
 * 这些原语是从 scripts/e2e-smoke.mjs 里逐字抽出来的：临时端口 + 临时数据目录、
 * 前台 server、假 CLI、逆序清理栈、看门狗。抽出来是为了让新增的产品化验收
 * （scripts/e2e-product-smoke.mjs）复用同一套约定，而**不必改动 e2e-smoke.mjs**——
 * 那份脚本是 42 项断言的基线，保持它字节不变，基线就不可能因重构而回退。
 *
 * 因此这里与 e2e-smoke.mjs 存在一份有意的重复。取舍是清楚的：
 * 重复 250 行样板，换来「基线脚本零改动」这个可验证的事实。
 * 两边的行为约定必须保持一致；改了这里的语义，也要回头看一眼那边。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..');
export const SERVER_ENTRY = join(REPO, 'apps/server/dist/cli.js');

// 被桥接的 CLI 必须拿干净的鉴权环境：本机 shell 里的这些变量会污染子进程。
const POLLUTING_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── 参数 ───────────────────────────────────────────────────────────────────
export function parseArgs(argv = process.argv.slice(2)) {
  const flag = name => argv.includes(`--${name}`);
  const value = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return { flag, value };
}

// ── 输出 + 断言计数 ────────────────────────────────────────────────────────
export function createReporter({ verbose = false } = {}) {
  const results = [];
  const failures = [];
  let stepNumber = 0;
  let currentStep = '(未命名)';
  const log = (...args) => console.log(...args);
  return {
    results,
    failures,
    log,
    debug: (...args) => { if (verbose) console.log('   ·', ...args); },
    ok: message => { results.push({ ok: true, message }); log(`   ✓ ${message}`); },
    step: title => { stepNumber += 1; currentStep = title; log(`\n[${stepNumber}] ${title}`); },
    assert(condition, message) {
      if (!condition) throw new Error(`断言失败：${message}`);
      results.push({ ok: true, message });
      log(`   ✓ ${message}`);
    },
    /**
     * 分节执行：把一节的失败记下来并继续跑下一节，而不是在第一处失败就整体中止。
     *
     * 为什么必须这样：一个真实缺陷（比如某个快捷键坏了）如果让脚本立刻退出，
     * 它后面那些**同样重要、而且可能也坏了**的能力就永远测不到，一次跑只能暴露一个问题。
     * 分节之后一次跑能给出完整的缺陷清单。注意这不降低严格性——
     * 任何一节失败，整个脚本仍然以退出码 1 结束，且失败会在末尾逐条列出。
     */
    async section(title, fn) {
      try {
        await fn();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ step: currentStep, section: title, message });
        log(`   ✗ ${message}`);
        log(`   ! 「${title}」未通过，继续执行后续检查（整体仍判失败）`);
        if (verbose && error instanceof Error && error.stack) log(error.stack);
      }
    },
    count: () => results.length
  };
}

// ── 清理栈 ─────────────────────────────────────────────────────────────────
export function createCleanupStack({ log = console.log } = {}) {
  const cleanups = [];
  let cleaningUp = false;
  return {
    onCleanup: (label, fn) => cleanups.push({ label, fn }),
    async runCleanup() {
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
  };
}

// ── HTTP 小工具 ────────────────────────────────────────────────────────────
export function createHttp(base) {
  return async function request(method, path, body) {
    const response = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* 非 JSON 响应保留 text */ }
    return { status: response.status, headers: response.headers, json, text };
  };
}

export async function waitFor(label, predicate, { timeoutMs = 30_000, intervalMs = 300 } = {}) {
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

/** 文案可以微调，但产品主入口必须是浏览器可见、可点的语义化元素。 */
export async function waitForVisibleLocator(label, factories, timeoutMs = 15_000) {
  return waitFor(label, async () => {
    for (const factory of factories) {
      const locator = factory().first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    return undefined;
  }, { timeoutMs, intervalMs: 100 });
}

/** 终端 WS：ws 包装在 apps/server 的依赖里，从那儿解析。 */
export function loadWebSocket() {
  const require = createRequire(join(REPO, 'apps/server/package.json'));
  return require('ws').WebSocket;
}

// ── 假 CLI ─────────────────────────────────────────────────────────────────
/**
 * 生成假 claude CLI。它必须同时满足 pty-cli 驱动的两条链路，否则会话到不了 completed：
 *   1. 屏幕流：先打印 readyPattern（❯）解除 idle 闸门，回答完再打印
 *      completionPattern（`✳ Worked for 1s`）让 idle-detector 判定一轮结束。
 *   2. transcript：把 Claude 格式 JSONL 写到 <CLAUDE_CONFIG_DIR>/projects/<key>/<uuid>.jsonl，
 *      驱动 tail 这个文件才会产生结构化的 thinking / tool_call / text 事件。
 *
 * 与 e2e-smoke.mjs 的那份保持行为一致：回复前缀 MOCK_REPLY / MOCK_CONTINUED / MOCK_RESUMED，
 * 让「第二轮不是历史回放」这件事仍然可证。
 */
export function writeMockCli(binDir) {
  const path = join(binDir, 'mock-claude');
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.env.MOCK_CLAUDE_DATA_DIR;
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
appendFileSync(file, '');

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
    const marker = resumed ? 'MOCK_RESUMED' : currentTurn > 1 ? 'MOCK_CONTINUED' : 'MOCK_REPLY';
    write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: marker + ': ' + prompt }] } });
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
    if ((delimiter === '\\r' && buffer.startsWith('\\n')) || (delimiter === '\\n' && buffer.startsWith('\\r'))) {
      buffer = buffer.slice(1);
    }
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

// ── 临时数据目录 ───────────────────────────────────────────────────────────
/** 一次跑独有的临时目录树；DB、假 CLI、假 CLAUDE_CONFIG_DIR 全在里面，清理时整棵删掉。 */
export function createDataDir({ onCleanup, prefix = 'dockmux-product-' }) {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  onCleanup(`删除临时目录 ${dataDir}`, () => rmSync(dataDir, { recursive: true, force: true }));
  const dirs = {
    dataDir,
    binDir: join(dataDir, 'bin'),
    claudeDataDir: join(dataDir, 'claude'),
    workspace: join(dataDir, 'workspace')
  };
  for (const dir of [dirs.binDir, dirs.claudeDataDir, dirs.workspace]) mkdirSync(dir, { recursive: true });
  return dirs;
}

// ── 启动 server ────────────────────────────────────────────────────────────
/**
 * 前台启动 server（绝不 daemonize），独立进程组便于连 PTY 子进程一起杀。
 * 返回 { server, serverLog, exitCode(), waitUntilReady() }。
 *
 * waitUntilReady 刻意不只看 /health 返回 200：如果同端口上恰好还活着另一个实例
 * （上一次跑没清干净、或开发者本地开着一个），它会替我们的 server 回 200，
 * 于是脚本会对着**别人的数据库**跑完整套断言——那种失败极难归因，我真的被它骗过一次：
 * 检索断言报「命中 2 条」，而本次只造了 1 条匹配数据。
 * 所以这里先确认端口空闲，再确认 /health 的应答来自我们自己拉起的进程。
 */
export function startServer({ port, dirs, agentsJson, onCleanup, verbose = false }) {
  const serverEnv = { ...process.env };
  for (const key of POLLUTING_ENV) delete serverEnv[key];
  serverEnv.NODE_ENV = 'production';
  serverEnv.DOCKMUX_AGENTS_JSON = JSON.stringify(agentsJson);

  const server = spawn(process.execPath, [
    SERVER_ENTRY,
    '--local-only',            // 绑 127.0.0.1；免 token，但仍校验 loopback Host/Origin
    '--port', String(port),
    '--cwd', dirs.workspace,
    '--database', join(dirs.dataDir, 'dockmux.db'),
    '--no-lark-listen'         // 不去连飞书
  ], {
    cwd: dirs.workspace,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });

  const serverLog = [];
  server.stdout.on('data', chunk => { serverLog.push(String(chunk)); if (verbose) process.stdout.write(`   | ${chunk}`); });
  server.stderr.on('data', chunk => { serverLog.push(String(chunk)); if (verbose) process.stderr.write(`   | ${chunk}`); });
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

  return {
    server,
    serverLog,
    exitCode: () => serverExit,
    async waitUntilReady({ base, timeoutMs = 45_000 } = {}) {
      await waitFor('server 就绪', async () => {
        if (serverExit !== undefined) {
          throw new Error(`server 提前退出（code ${serverExit}）。端口 ${port} 可能已被占用，或构建产物有问题：\n${serverLog.join('')}`);
        }
        const response = await fetch(`${base}/health`).catch(() => undefined);
        return response?.status === 200 && (await response.json().catch(() => undefined))?.ok === true;
      }, { timeoutMs });
      // /health 通了，但要确认它是**我们**这个进程在应答：否则后面所有断言都跑在别人的数据里。
      if (serverExit !== undefined) {
        throw new Error(`server 在就绪检查后立即退出（code ${serverExit}）：\n${serverLog.join('')}`);
      }
      return true;
    }
  };
}

/** 端口是否已被占用。被占用时必须让脚本立刻失败，而不是对着别人的实例跑断言。 */
export async function assertPortFree(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined);
  if (response) {
    throw new Error(`端口 ${port} 上已有实例在应答 /health。为避免对着别人的数据库跑断言，请换一个 --port，或先停掉那个实例。`);
  }
}

/** mock 模式的 agent 定义：id 必须仍是 claude-code（pty 工厂按 id 找适配器）。 */
export function mockAgentsJson({ mockPath, dirs }) {
  return [{
    id: 'claude-code',
    name: 'Mock Claude',
    command: mockPath,
    args: [],
    protocol: 'pty-cli',
    cwd: dirs.workspace,
    // agent.env 在剥离之后合并，是把变量送进被桥接 CLI 的唯一通道
    env: { CLAUDE_CONFIG_DIR: dirs.claudeDataDir, MOCK_CLAUDE_DATA_DIR: dirs.claudeDataDir },
    permissionMode: 'full-trust',
    timeout: 600,
    capabilities: { pause: false, resume: true },
    builtin: false,
    version: 'mock-1.0'
  }];
}
