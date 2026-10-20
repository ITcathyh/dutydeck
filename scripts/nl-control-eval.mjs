#!/usr/bin/env node
/**
 * 中文大白话 → Dutydeck 控制操作判定评测。
 *
 * 用法：
 *   node scripts/nl-control-eval.mjs                 # 跑全部用例、全部可用 agent，写报告
 *   node scripts/nl-control-eval.mjs --agents ccflash
 *   node scripts/nl-control-eval.mjs --id R27 --id R30
 *   node scripts/nl-control-eval.mjs --report /tmp/report.md --cases tests/nl-control-eval/cases.json
 *
 * 前置：pnpm install && pnpm build（工作区包从各自 dist 加载）。脚本每次启动都从源码把
 * apps/server/src/nl-eval-entry.ts 打包到 apps/server/node_modules/.cache/nl-eval/nl-eval.mjs，不碰线上构建。
 *
 * 做了什么：
 *   1. 用评测包里的 buildEvalPrompt（线上 LarkAgentToolsService.promptForSession）
 *      拼每轮注入说明，不手抄提示文本。
 *   2. PATH 最前面放 scripts/nl-eval-stub.mjs（名为 dutydeck）：--help 渲染真实帮助，其余调用
 *      记录到 per-case JSONL 并返回模拟 JSON，不连服务、无副作用。
 *   3. 每条用例 × 每个 agent 在独立临时目录非交互跑一次，并发 ≤3，单条超时 180s。
 *   4. 打分用 scripts/nl-control-eval-score.mjs，输出 markdown 报告。
 *
 * agent 调用都用洗净环境（env 白名单），ccflash 用临时 HOME + 其 wrapper 同款环境变量直调 claude，
 * 不执行会改写 ~/.claude/settings.json 的 ccflash alias，因此可以安全并发。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCase } from './nl-control-eval-score.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evalBundle = join(root, 'apps/server/node_modules/.cache/nl-eval/nl-eval.mjs');
const stubPath = join(root, 'scripts/nl-eval-stub.mjs');
const defaultCases = join(root, 'tests/nl-control-eval/cases.json');
const defaultReport = join(root, 'artifacts/nl-control-eval/report.md');

function parseArgs(argv) {
  const options = { agents: null, report: defaultReport, cases: defaultCases, ids: [], concurrency: 3, timeoutMs: 180_000, probe: true, retries: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agents') options.agents = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--report') options.report = argv[++i];
    else if (arg === '--cases') options.cases = argv[++i];
    else if (arg === '--id') options.ids.push(argv[++i]);
    else if (arg === '--concurrency') options.concurrency = Number(argv[++i]);
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i]);
    else if (arg === '--no-probe') options.probe = false;
    else if (arg === '--retries') options.retries = Number(argv[++i]);
    else { console.error(`未知参数 ${arg}`); process.exit(2); }
  }
  return options;
}

/** 读 ~/cliproxyapi/.api-key；只放进子进程环境，不打印。 */
function ccflashToken() {
  try { return readFileSync(`${process.env.HOME}/cliproxyapi/.api-key`, 'utf8').trim(); }
  catch { return ''; }
}

const realHome = process.env.HOME;
const pathEnv = process.env.PATH;
const ccflashEnv = (home) => ({
  HOME: home, PATH: pathEnv, USER: process.env.USER, SHELL: '/bin/zsh', TERM: 'xterm-256color', LANG: 'zh_CN.UTF-8',
  CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080',
  ANTHROPIC_AUTH_TOKEN: ccflashToken(), ANTHROPIC_MODEL: 'gemini-3.8-flash-high',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'gemini-3.8-flash-high', ANTHROPIC_DEFAULT_SONNET_MODEL: 'gemini-3.8-flash-high',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gemini-3.8-flash-high', CLAUDE_CODE_SUBAGENT_MODEL: 'gemini-3.8-flash-high',
  CLAUDE_CODE_EFFORT_LEVEL: 'max', API_TIMEOUT_MS: '3000000'
});
const cleanEnv = () => ({ HOME: realHome, PATH: pathEnv, USER: process.env.USER, SHELL: '/bin/zsh', TERM: 'xterm-256color', LANG: 'zh_CN.UTF-8' });

async function parseClaudeResult(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { const parsed = JSON.parse(lines[i]); if (typeof parsed.result === 'string') return parsed.result; } catch { /* 非 JSON 输出行 */ }
  }
  return '';
}

/**
 * @typedef {Object} AgentSpec
 * @property {string} label
 * @property {() => Promise<string>} prepareHome
 * @property {(workdir:string, home:string, stubBin:string, promptFile:string, lastMessageFile:string) => {cmd:string, args:string[], env:NodeJS.ProcessEnv}} spawn
 * @property {(stdout:string, lastMessageFile:string) => Promise<string>} parse
 */
const agents = {
  ccflash: {
    label: 'ccflash (gemini-3.8-flash-high，临时 HOME 直调)',
    prepareHome: async () => (await mkdtemp(join(tmpdir(), 'nl-eval-home-'))),
    spawn: (workdir, home, stubBin, promptFile) => ({
      cmd: 'claude',
      args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions'],
      env: { ...ccflashEnv(home), PATH: `${stubBin}:${pathEnv}` }
    }),
    parse: parseClaudeResult
  },
  claude: {
    label: 'claude (auto_model/alwaysday1_max)',
    prepareHome: async () => realHome,
    spawn: (workdir, home, stubBin, promptFile) => ({
      cmd: 'claude',
      args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions'],
      env: { ...cleanEnv(), PATH: `${stubBin}:${pathEnv}` }
    }),
    parse: parseClaudeResult
  },
  traex: {
    label: 'traex (默认模型)',
    prepareHome: async () => realHome,
    spawn: (workdir, home, stubBin, promptFile, lastMessageFile) => ({
      cmd: 'traex',
      args: ['exec', '--skip-git-repo-check', '--ephemeral', '--permission-mode', 'bypass_permissions', '--color', 'never', '--output-last-message', lastMessageFile],
      env: { ...cleanEnv(), PATH: `${stubBin}:${pathEnv}` }
    }),
    parse: async (stdout, lastMessageFile) => {
      try { const text = await readFile(lastMessageFile, 'utf8'); if (text.trim()) return text.trim(); } catch { /* 文件没写成时退回收尾输出 */ }
      return stdout.trim();
    }
  }
};

/** 用例里的相对日期按运行当天（本地时区）展开，换一天复跑不用改用例。 */
function expandDates(text, now = new Date()) {
  const day = offset => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  return text.replaceAll('{{tomorrow}}', day(1)).replaceAll('{{nextMonday}}', day((8 - now.getDay()) % 7 || 7));
}

function buildUserMessage(testCase) {
  const scenario = testCase.scenario ?? {};
  const lines = [];
  // 会话背景在真实环境里是对话历史/宿主状态；评测无历史，用一行场景前缀补齐 agent 判定所需的信息。
  if (scenario.context) lines.push(`（会话背景：${scenario.context}）`);
  lines.push(testCase.utterance);
  return lines.join('\n');
}

function runProcess(spec, workdir, prompt, logFile, timeoutMs) {
  return new Promise(resolve => {
    const lastMessageFile = join(workdir, 'last-message.txt');
    const prepared = spec.spawn(workdir, spec.home, spec.stubBin, join(workdir, 'prompt.txt'), lastMessageFile);
    const child = spawn(prepared.cmd, prepared.args, {
      cwd: workdir, env: { ...prepared.env, NL_EVAL_LOG: logFile }, stdio: ['pipe', 'pipe', 'pipe'], detached: true
    });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 已退出 */ } }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: `${stderr}${error.message}`, timedOut }); });
    child.on('close', async code => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut, lastMessageFile });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 渠道限流、网关抖动、单轮超时这类瞬时失败值得退避重试，不能直接算 Agent 漏做。 */
function isTransientFailure(run, answer) {
  if (run.timedOut) return true;
  const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.toLowerCase();
  return /queue size|rate ?limit|too many requests|429|overloaded|temporarily unavailable|bad gateway|502|503|504|econnreset|socket hang up|network error|fetch failed|timeout|timed out/.test(text)
    || (run.ok && !answer);
}

async function runOne(buildEvalPrompt, agentId, spec, testCase, options) {
  const scenario = testCase.scenario ?? {};
  const userMessage = buildUserMessage(testCase);
  const prompt = await buildEvalPrompt({ chatType: scenario.chatType ?? 'group', activeTask: scenario.activeTask !== false, userPrompt: userMessage });

  const started = Date.now();
  let last = null;
  // 瞬时失败（渠道限流、网关抖动、超时）退避重试，避免把服务端问题记成 Agent 漏做。
  for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
    const attemptResult = await runAttempt(agentId, spec, prompt, options);
    last = attemptResult;
    const answer = attemptResult.run.ok ? await spec.parse(attemptResult.run.stdout, attemptResult.run.lastMessageFile) : '';
    attemptResult.answer = answer;
    if (attemptResult.run.ok || !isTransientFailure(attemptResult.run, answer) || attempt > options.retries) break;
    await rm(attemptResult.workdir, { recursive: true, force: true }).catch(() => {});
    if (attemptResult.home !== realHome) await rm(attemptResult.home, { recursive: true, force: true }).catch(() => {});
    await sleep(20_000 * attempt);
  }

  const { workdir, home, run, logFile } = last;
  const elapsedMs = Date.now() - started;
  const answer = run.ok ? last.answer : '';

  let calls = [];
  try {
    calls = (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { /* 没有任何调用时文件不存在 */ }

  const scored = scoreCase(testCase.expected, calls, answer);
  if (home !== realHome) await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
  // 进程失败只含超时/非零退出；空回答是 Agent 的行为结果，由打分处理，不算基础设施失败。
  const processError = run.timedOut ? `超时 ${options.timeoutMs}ms` : !run.ok ? `退出码 ${run.code ?? 'unknown'}${run.stderr ? `：${run.stderr.slice(-300)}` : ''}` : undefined;
  return {
    id: testCase.id, agent: agentId, utterance: testCase.utterance, expected: testCase.expected,
    verdict: scored.verdict, reasons: scored.reasons,
    calls: calls.filter(c => c.kind === 'call' || (c.kind === 'error' && c.operation)).map(c => ({ operation: c.operation, risk: c.risk ?? 'unknown', args: c.args ?? [], options: c.options ?? {}, ...(c.kind === 'error' ? { argv: c.argv, error: c.error } : {}) })),
    answer, elapsedMs, ...(processError ? { error: processError } : {})
  };
}

/** 一次执行：独立临时目录、桩、ccflash HOME 和调用记录。 */
async function runAttempt(agentId, spec, prompt, options) {
  const workdir = await mkdtemp(join(tmpdir(), `nl-eval-${agentId}-`));
  const stubBin = join(workdir, 'bin');
  await mkdir(stubBin, { recursive: true });
  await symlink(stubPath, join(stubBin, 'dutydeck'));
  const home = await spec.prepareHome();
  const logFile = join(workdir, 'calls.jsonl');
  const run = await runProcess({ ...spec, home, stubBin }, workdir, prompt, logFile, options.timeoutMs);
  return { workdir, home, run, logFile };
}

async function probeAgent(agentId, spec) {
  const workdir = await mkdtemp(join(tmpdir(), `nl-eval-probe-${agentId}-`));
  const stubBin = join(workdir, 'bin');
  await mkdir(stubBin, { recursive: true });
  await symlink(stubPath, join(stubBin, 'dutydeck'));
  const home = await spec.prepareHome();
  const run = await runProcess({ ...spec, home, stubBin }, workdir, '只回复两个字：在的', join(workdir, 'probe-calls.jsonl'), 120_000);
  const answer = run.ok ? await spec.parse(run.stdout, run.lastMessageFile) : '';
  // 渠道异常（未登录、模型不可用）时 CLI 仍可能退出 0 并返回一句提示，必须校验回答内容。
  const healthy = answer.includes('在的');
  if (home !== realHome) await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
  return { ok: healthy, detail: healthy ? answer.slice(-80) : (run.timedOut ? 'hi 探测超时' : run.ok ? `回答异常：${answer.slice(-120)}` : `退出码 ${run.code}: ${run.stderr.slice(-200)}`) };
}

const verdictLabel = { correct: '做对', wrong: '做错', miss: '漏做', ask: '反问' };

function summarize(results) {
  const byAgent = new Map();
  for (const result of results) {
    if (!byAgent.has(result.agent)) byAgent.set(result.agent, { total: 0, correct: 0, wrong: 0, miss: 0, ask: 0, errors: 0, elapsedMs: 0 });
    const stats = byAgent.get(result.agent);
    stats.total += 1; stats[result.verdict] += 1; stats.elapsedMs += result.elapsedMs;
    if (result.error) stats.errors += 1;
  }
  return byAgent;
}

/** 按类别归并最容易错的说法，供报告开头结论使用。 */
const categoryOf = (testCase) => {
  const op = testCase.expected.operation ?? '';
  if (testCase.expected.kind === 'none' || testCase.expected.kind === 'ask') return '反例/歧义（不该动或该反问）';
  if (op.startsWith('schedule')) return '定时任务';
  if (op.startsWith('session')) return '换 Agent/模型';
  if (op === 'retry' || op === 'plan') return '重试/先出计划';
  if (op.startsWith('ci') || op === 'queue.cancel' || op === 'queue.top') return 'CI/排队';
  if (op === 'pr.open') return '开 PR';
  if (op.startsWith('access')) return '授权';
  if (op.startsWith('memory')) return '记忆';
  if (op.startsWith('group') || op.startsWith('history')) return '查历史/发消息';
  return '只读查询';
};

function buildReport({ cases, results, skippedAgents, startedAt, finishedAt, options, agentOrder }) {
  const stats = summarize(results);
  // 列顺序固定为实际参与的 agent（按 --agents/探测顺序），不随完成先后变化。
  const agentIds = agentOrder.filter(id => stats.has(id));
  const totalSeconds = ((finishedAt - startedAt) / 1000).toFixed(0);
  // 错得最多的类别
  const categoryErrors = new Map();
  for (const result of results) {
    if (result.verdict === 'wrong' || result.verdict === 'miss' || (result.verdict === 'ask' && result.expected.kind === 'command')) {
      const testCase = cases.find(c => c.id === result.id);
      const category = categoryOf(testCase);
      categoryErrors.set(category, (categoryErrors.get(category) ?? 0) + 1);
    }
  }
  const worstCategories = [...categoryErrors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name}（${count} 次错/漏）`).join('、') || '无明显集中错误';

  const lines = [];
  lines.push('# 中文说法 → Dutydeck 控制操作判定评测');
  lines.push('');
  lines.push(`生成时间：${new Date(finishedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(`- **最容易错的说法**：${worstCategories}。`);
  lines.push(`- 共 ${cases.length} 条用例 × ${agentIds.length} 个 agent = ${results.length} 次判定，总耗时 ${Math.round(Number(totalSeconds) / 60)} 分 ${Number(totalSeconds) % 60} 秒（并发上限 ${options.concurrency}）。`);
  lines.push('- 复跑：');
  lines.push('  ```bash');
  lines.push('  node scripts/nl-control-eval.mjs');
  lines.push('  ```');
  if (skippedAgents.length) {
    lines.push('- 未参与的 agent：');
    for (const skipped of skippedAgents) lines.push(`  - ${skipped.id}：${skipped.reason}`);
  }
  lines.push('');
  lines.push('## 总表');
  lines.push('');
  lines.push('| Agent | 做对 | 做错 | 漏做 | 反问(判错) | 准确率 | 进程失败 |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const agentId of agentIds) {
    const s = stats.get(agentId);
    const accuracy = `${((s.correct / s.total) * 100).toFixed(1)}%`;
    lines.push(`| ${agents[agentId]?.label ?? agentId} | ${s.correct} | ${s.wrong} | ${s.miss} | ${s.ask} | ${accuracy} | ${s.errors} |`);
  }
  lines.push('');
  lines.push('> 准确率 = 做对 / 总条数。期望为 ask 的用例反问算做对；期望为 command 却反问计入「反问(判错)」。');
  lines.push('');
  lines.push('## 每条用例结果');
  lines.push('');
  lines.push('| 用例 | 说法 | 期望 | ' + agentIds.join(' | ') + ' |');
  lines.push('| --- | --- | --- |' + ' --- |'.repeat(agentIds.length));
  for (const testCase of cases) {
    const cells = [];
    for (const agentId of agentIds) {
      const result = results.find(r => r.id === testCase.id && r.agent === agentId);
      cells.push(result ? verdictLabel[result.verdict] : '—');
    }
    const expected = testCase.expected.kind === 'command'
      ? `执行 ${testCase.expected.operation}${testCase.expected.params?.handoff ? '（带 handoff）' : ''}`
      : testCase.expected.kind === 'ask' ? '反问' : '不执行';
    lines.push(`| ${testCase.id} | ${testCase.utterance.replace(/\|/g, '丨')} | ${expected} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  for (const agentId of agentIds) {
    const bad = results.filter(r => r.agent === agentId && (r.verdict === 'wrong' || r.verdict === 'miss' || (r.verdict === 'ask' && r.expected.kind === 'command')));
    lines.push(`## ${agents[agentId]?.label ?? agentId}：做错与漏做摘录`);
    lines.push('');
    if (!bad.length) { lines.push('无。'); lines.push(''); continue; }
    for (const result of bad) {
      lines.push(`### ${result.id} ${verdictLabel[result.verdict]}｜${result.utterance}`);
      lines.push('');
      lines.push(`- 期望：${result.expected.kind === 'command' ? `执行 ${result.expected.operation}` : result.expected.kind}`);
      lines.push(`- 实际调用：${result.calls.map(c => `${c.operation}${c.options?.dryRun ? '（预览）' : ''}${c.error ? `（报错：${c.error}）` : ''}`).join('、') || '无'}`);
      if (result.error) lines.push(`- 进程问题：${result.error}`);
      const excerpt = (result.answer || '(空回答)').split('\n').filter(Boolean).slice(0, 5).join('\n> ');
      lines.push('- 回答摘录：');
      lines.push(`> ${excerpt}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { build } = createRequire(join(root, 'apps/server/package.json'))('esbuild');
  await build({
    entryPoints: [join(root, 'apps/server/src/nl-eval-entry.ts')], outfile: evalBundle,
    bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', logLevel: 'warning'
  });
  const { buildEvalPrompt } = await import(evalBundle);
  const casesFile = JSON.parse(expandDates(readFileSync(options.cases, 'utf8')));
  const cases = casesFile.cases.filter(testCase => testCase.judge === 'agent' && (!options.ids.length || options.ids.includes(testCase.id)));

  let selected = options.agents ?? ['ccflash', 'claude', 'traex'];
  const skippedAgents = [];
  if (options.probe && !options.agents) {
    const available = [];
    for (const agentId of selected) {
      // hi 探测也可能撞上渠道瞬时限流/超时，重试 3 次再判定不可用，避免误淘汰。
      let probe = { ok: false, detail: '未探测' };
      for (let attempt = 1; attempt <= 3 && !probe.ok; attempt += 1) {
        process.stdout.write(attempt === 1 ? `探测 ${agentId}…` : ` ${attempt}…`);
        probe = await probeAgent(agentId, agents[agentId]);
        if (!probe.ok && attempt < 3) await sleep(15_000);
      }
      process.stdout.write(probe.ok ? ' 可用\n' : ` 跳过（${probe.detail}）\n`);
      if (probe.ok) available.push(agentId);
      else skippedAgents.push({ id: agentId, reason: probe.detail });
    }
    selected = available;
  }
  // codex：开发机连不上 OpenAI，按评测约定固定跳过。
  if (!skippedAgents.some(s => s.id === 'codex') && !(options.agents ?? []).includes('codex')) {
    skippedAgents.push({ id: 'codex', reason: '开发机连不上 OpenAI，按评测约定跳过' });
  }
  if (!selected.length) { console.error('没有可用 agent'); process.exit(1); }

  console.log(`用例 ${cases.length} 条，agent：${selected.join('、')}，并发 ${options.concurrency}，单条超时 ${options.timeoutMs}ms`);
  const startedAt = Date.now();
  const results = [];
  // 按 agent 轮转交错入队，避免 3 个 worker 同时压同一渠道（traex 后端会返回 queue size exceeded）。
  const queue = [];
  for (let i = 0; i < cases.length; i += 1) for (const agentId of selected) queue.push({ agentId, testCase: cases[i] });
  let cursor = 0, done = 0;
  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      try {
        results.push(await runOne(buildEvalPrompt, item.agentId, agents[item.agentId], item.testCase, options));
      } catch (error) {
        results.push({ id: item.testCase.id, agent: item.agentId, utterance: item.testCase.utterance, expected: item.testCase.expected, verdict: 'miss', reasons: [error.message], calls: [], answer: '', elapsedMs: 0, error: error.message });
      }
      done += 1;
      if (done % 5 === 0 || done === queue.length) process.stdout.write(`\r${done}/${queue.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, worker));
  process.stdout.write('\n');
  const finishedAt = Date.now();

  const report = buildReport({ cases, results, skippedAgents, startedAt, finishedAt, options, agentOrder: selected });
  await writeFile(options.report, report);
  // 原始调用和回答留档，改打分或核对单条时不用重跑。
  await writeFile(options.report.replace(/\.md$/, '') + '.json', `${JSON.stringify(results, null, 2)}\n`);
  const stats = summarize(results);
  for (const [agentId, s] of stats) console.log(`${agentId}: 做对 ${s.correct}/${s.total}，错 ${s.wrong}，漏 ${s.miss}，反问 ${s.ask}，失败 ${s.errors}`);
  console.log(`报告：${options.report}`);
}

main().catch(error => { console.error(error); process.exit(1); });
