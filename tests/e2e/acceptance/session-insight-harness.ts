import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  REPO_ROOT,
  launchIsolatedTestServer,
  type TestServerInstance
} from './harness.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Dutydeck 钉给 Claude 的原生 UUID 计算规则（与 cli-adapters/resume-id.ts 一致） */
export function pinnedSessionUuid(sessionId: string): string {
  if (!sessionId.startsWith('ses_')) return sessionId;
  const bare = sessionId.slice('ses_'.length);
  if (UUID_RE.test(bare)) return bare;
  const hex = createHash('sha256').update(sessionId).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 | parseInt(hex[16]!, 16) & 3).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** 真实的 Dutydeck 首轮注入 marker 结构（与 pty-driver/session-id/marker.ts 一致） */
export function buildSessionMarker(sessionId: string): string {
  return `<dutydeck_session_id>${sessionId}</dutydeck_session_id>`;
}

export const REAL_NATIVE_FIXTURE_DIR = resolve(REPO_ROOT, 'tests/fixtures/session-insight/real-native');

/**
 * createSession 的受控输入（测试 helper，非生产选项）。
 * nativeSessionId 仅 codex/traex 生效：允许跨实例/会话在真实 submit 前种入同一 nativeID；
 * Claude 始终 pinned，传入也会被忽略。
 */
export interface CreateSessionOptions {
  nativeSessionId?: string;
}

export interface SessionInsightTestEnvironment {
  instance: TestServerInstance;
  claudeDataDir: string;
  codexHome: string;
  traeHome: string;
  assetsDir: string;
  createSession(
    client: 'claude' | 'codex' | 'traex',
    prompt?: string,
    options?: CreateSessionOptions
  ): Promise<{
    sessionId: string;
    nativeSessionId: string;
    nativeAgentId?: string;
    mainPath: string;
    subagentPath?: string;
  }>;
}

export interface LaunchSessionInsightTestServerOptions {
  prefix?: string;
  extraEnv?: NodeJS.ProcessEnv;
  serverArgs?: string[];
}

/**
 * 编写三客户端（Claude, Codex, TraeX）的受控执行 CLI shim。
 *
 * 关键（对照 pty-driver 真实完成链路）：
 *  - 输出匹配适配器 screen-ready 正则的就绪横幅与 composer，driver 才允许投递。
 *  - 收到真实 stdin（driver 首轮会前置 routing block + <dutydeck_session_id> marker）后，
 *    必须像真 CLI 一样向 transcript 追加一条「文本与提交内容逐字一致」的 user 记录，
 *    driver 的 native input receipt（tailer waitForInput，严格 === 比较）才会解除等待；
 *    随后追加 assistant / task_complete 完成记录，本轮才真实 completed。
 *  - Codex/TraeX rollout 路径经 INSIGHT_ROLLOUT_MANIFEST 的 current 字段取得
 *    （helper 在 spawn 前写好），绝不靠猜 mtime。
 */
function writeInsightMockCli(binDir: string, client: 'claude' | 'codex' | 'traex'): string {
  const cliPath = join(binDir, `mock-${client}`);
  const scriptContent = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const client = ${JSON.stringify(client)};

const nowIso = () => new Date().toISOString();
const appendLine = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(obj) + '\\n'); };

// 解析 --session-id（claude 由 driver 以裸 UUID 钉入）
const sessionArgIndex = process.argv.indexOf('--session-id');
const pinnedSessionId = sessionArgIndex >= 0 ? process.argv[sessionArgIndex + 1] : undefined;

// 启动就绪横幅：必须匹配各适配器 pollScreenReady / readyPattern
if (client === 'claude') {
  process.stdout.write('Claude Code v2.1.288 (mock)\\r\\n\\u276f ');
} else if (client === 'codex') {
  process.stdout.write(
    '\\r\\n│  >_ OpenAI Codex (v0.160.0)  │\\r\\n' +
    '│  model: gpt-6-astra          │\\r\\n' +
    '│  directory: ' + (process.cwd() || '/repo') + ' │\\r\\n' +
    'Context 100% left\\r\\n\\u203a Ask Codex to do anything\\r\\n'
  );
} else {
  process.stdout.write(
    'TraeX\\r\\n' +
    'Context 100% left\\r\\n\\u203a Ask Trae to do anything\\r\\n'
  );
}

// bracketed-paste 行收集（与 core mock-claude 同协议），submit 文本即 driver 逐字投递内容
let buffer = '';
let composedPrompt = '';
let bracketedPaste = false;
const pasteStart = '\\u001b[200~';
const pasteEnd = '\\u001b[201~';

function claudeTranscriptPath() {
  const dataDir = process.env.CLAUDE_CONFIG_DIR;
  if (!dataDir || !pinnedSessionId) return undefined;
  let realCwd = process.cwd();
  try { realCwd = fs.realpathSync(process.cwd()); } catch {}
  const projectKey = realCwd.replace(/[^A-Za-z0-9-]/g, '-');
  return path.join(dataDir, 'projects', projectKey, pinnedSessionId + '.jsonl');
}

function currentRolloutPath() {
  const manifest = process.env.INSIGHT_ROLLOUT_MANIFEST;
  if (!manifest || !fs.existsSync(manifest)) return undefined;
  try { const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')); return parsed.current || undefined; } catch { return undefined; }
}

function submitPrompt(rawPrompt) {
  const text = rawPrompt.replace(/\\r\\n?/g, '\\n').trimEnd();
  if (!text) return;

  if (client === 'claude') {
    const file = claudeTranscriptPath();
    if (file) {
      // 逐字 user 记录：tailer waitForInput 严格 === 比较
      appendLine(file, { type: 'user', sessionId: pinnedSessionId, cwd: process.cwd(), timestamp: nowIso(), message: { role: 'user', content: text } });
      appendLine(file, { type: 'assistant', sessionId: pinnedSessionId, cwd: process.cwd(), timestamp: nowIso(), message: { role: 'assistant', content: [{ type: 'text', text: 'CONTROLLED_CLAUDE_TASK_DONE' }] } });
    }
    setTimeout(() => {
      process.stdout.write('\\r\\nCONTROLLED_CLAUDE_TASK_DONE\\r\\n\\u001b[2J\\u001b[HClaude Code v2.1.288 (mock)\\r\\n\\u2733 Worked for 1s\\r\\n\\u276f ');
    }, 200);
    return;
  }

  // codex / traex 共用 codex 家族 transcript 方言
  const file = currentRolloutPath();
  if (file) {
    // response_item user message —— codexInputText 识别并逐字匹配
    appendLine(file, { timestamp: nowIso(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text }] } });
    // task_complete —— 现代 codex/traex mapper 的唯一 final-answer 来源，触发本轮完成
    appendLine(file, { timestamp: nowIso(), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'CONTROLLED_TASK_DONE', completed_at: Math.floor(Date.now() / 1000) } });
  }
  const label = client === 'codex' ? 'Codex' : 'Trae';
  setTimeout(() => {
    process.stdout.write('\\r\\nCONTROLLED_TASK_DONE\\r\\nContext 99% left\\r\\n\\u203a Ask ' + label + ' to do anything\\r\\n');
  }, 200);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    if (bracketedPaste) {
      const end = buffer.indexOf(pasteEnd);
      if (end < 0) return;
      composedPrompt += buffer.slice(0, end);
      buffer = buffer.slice(end + pasteEnd.length);
      bracketedPaste = false;
      continue;
    }
    const start = buffer.indexOf(pasteStart);
    const lineBreak = /[\\r\\n]/.exec(buffer);
    if (start >= 0 && (!lineBreak || start < lineBreak.index)) {
      composedPrompt += buffer.slice(0, start);
      buffer = buffer.slice(start + pasteStart.length);
      bracketedPaste = true;
      continue;
    }
    if (!lineBreak) return;
    composedPrompt += buffer.slice(0, lineBreak.index);
    const delimiter = lineBreak[0];
    buffer = buffer.slice(lineBreak.index + delimiter.length);
    if ((delimiter === '\\r' && buffer.startsWith('\\n')) || (delimiter === '\\n' && buffer.startsWith('\\r'))) buffer = buffer.slice(1);
    if (composedPrompt.endsWith('\\\\')) { composedPrompt = composedPrompt.slice(0, -1) + '\\n'; continue; }
    const prompt = composedPrompt;
    composedPrompt = '';
    submitPrompt(prompt);
  }
});
process.stdin.resume();
`;

  writeFileSync(cliPath, scriptContent, { mode: 0o755 });
  return cliPath;
}

/**
 * 启动隔离且预先注册好三客户端 Agents 的测试服务。
 */
export async function launchSessionInsightTestServer(
  options: LaunchSessionInsightTestServerOptions = {}
): Promise<SessionInsightTestEnvironment> {
  const prefix = options.prefix ?? 'dutydeck-acc-insight-';

  let capturedClaudeDataDir = '';
  let capturedCodexHome = '';
  let capturedTraeHome = '';
  let capturedAssetsDir = '';

  const instance = await launchIsolatedTestServer({
    prefix,
    extraEnv: options.extraEnv,
    serverArgs: options.serverArgs,
    beforeLaunch: ({ dataDir, binDir, sourceRepo }) => {
      capturedClaudeDataDir = join(dataDir, 'claude-root');
      capturedCodexHome = join(dataDir, 'codex-root');
      capturedTraeHome = join(dataDir, 'trae-root');
      capturedAssetsDir = join(dataDir, 'engine-assets');

      mkdirSync(capturedClaudeDataDir, { recursive: true });
      mkdirSync(capturedCodexHome, { recursive: true });
      mkdirSync(capturedTraeHome, { recursive: true });
      mkdirSync(capturedAssetsDir, { recursive: true });

      const claudeCli = writeInsightMockCli(binDir, 'claude');
      const codexCli = writeInsightMockCli(binDir, 'codex');
      const traexCli = writeInsightMockCli(binDir, 'traex');

      const agents = [
        {
          id: 'claude-code',
          name: 'Claude Code Agent',
          command: claudeCli,
          args: [],
          protocol: 'pty-cli',
          cwd: sourceRepo,
          env: { CLAUDE_CONFIG_DIR: capturedClaudeDataDir, MOCK_CLAUDE_DATA_DIR: capturedClaudeDataDir },
          permissionMode: 'full-trust',
          timeout: 600,
          capabilities: { pause: false, resume: true },
          builtin: false,
          version: '2.1.288'
        },
        {
          id: 'codex',
          name: 'Codex Agent',
          command: codexCli,
          args: [],
          protocol: 'pty-cli',
          cwd: sourceRepo,
          env: {
            CODEX_HOME: capturedCodexHome,
            // 顺序创建会话时，createSession 在 send 前把当前 rollout 路径写入此 manifest；
            // shim 收到真实 stdin 后读它，精确向该 rollout 追加本轮记录与 history。
            INSIGHT_ROLLOUT_MANIFEST: join(capturedCodexHome, '.insight-current.json')
          },
          permissionMode: 'full-trust',
          timeout: 600,
          capabilities: { pause: false, resume: true },
          builtin: false,
          version: '0.160.0'
        },
        {
          id: 'traex',
          name: 'TraeX Agent',
          command: traexCli,
          args: [],
          protocol: 'pty-cli',
          cwd: sourceRepo,
          env: {
            TRAE_HOME: capturedTraeHome,
            INSIGHT_ROLLOUT_MANIFEST: join(capturedTraeHome, 'cli', '.insight-current.json')
          },
          permissionMode: 'full-trust',
          timeout: 600,
          capabilities: { pause: false, resume: true },
          builtin: false,
          version: '0.208.1-alpha.5'
        }
      ];

      return {
        agents,
        extraEnv: {
          CLAUDE_CONFIG_DIR: capturedClaudeDataDir,
          CODEX_HOME: capturedCodexHome,
          TRAE_HOME: capturedTraeHome
        }
      };
    }
  });

  const claudeDataDir = capturedClaudeDataDir;
  const codexHome = capturedCodexHome;
  const traeHome = capturedTraeHome;
  const assetsDir = capturedAssetsDir;

  /**
   * 创建受控会话并在真实 PTY 执行时将真实脱敏 native 日志安全注入到对应目录。
   * 每会话拥有唯一 nativeSessionId，定点注入真实 marker 与当前 cwd，
   * 100% 保留真实 usage、model、tool rows 与 timestamp。
   */
  const createSession = async (
    client: 'claude' | 'codex' | 'traex',
    prompt = 'EXECUTE_CONTROLLED_SESSION_TASK',
    options: CreateSessionOptions = {}
  ) => {
    const agentId = client === 'claude' ? 'claude-code' : client;
    const sourceRepo = instance.sourceRepo;

    const createRes = await instance.request('POST', '/api/sessions', {
      cwd: sourceRepo,
      agentId
    });
    if (createRes.status !== 200) {
      throw new Error(`Failed to create session for agent ${agentId}: ${createRes.text}`);
    }
    const sessionId = createRes.json.id as string;
    // Claude 的原生 session id 始终是 driver 钉入的 pinned UUID（不可 override）；
    // codex/traex 默认各铸 UUID，可由 options.nativeSessionId 指定同一 nativeID。
    const nativeSessionId = client === 'claude'
      ? pinnedSessionUuid(sessionId)
      : (options.nativeSessionId ?? randomUUID());
    const marker = buildSessionMarker(sessionId);
    // driver 首轮在用户 prompt 前注入 routing block + marker，并以换行分隔；
    // shim 逐字落盘的正是这个完整提交文本（与 native input receipt 严格匹配）。
    const submittedText = `${marker}\n${prompt}`;

    let mainPath = '';
    let subagentPath: string | undefined;
    let nativeAgentId: string | undefined;

    if (client === 'claude') {
      nativeAgentId = `a${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      // driver 以 --session-id <pinned> spawn，transcript 文件名即 pinned UUID。
      const pinned = nativeSessionId;
      const projectKey = sourceRepo.replace(/[^A-Za-z0-9-]/g, '-');
      const projectDir = join(claudeDataDir, 'projects', projectKey);
      mkdirSync(projectDir, { recursive: true });

      mainPath = join(projectDir, `${pinned}.jsonl`);
      const subagentsDir = join(projectDir, pinned, 'subagents');
      mkdirSync(subagentsDir, { recursive: true });
      // 真实 Claude 子流文件命名为 agent-<agentId>.jsonl（resolver 按此前缀边界核验）。
      subagentPath = join(subagentsDir, `agent-${nativeAgentId}.jsonl`);

      // 真实主流日志：定点替换 sessionId 与 cwd（resolver 按实例真实 sourceRepo 核验）；
      // 保留真实 usage/model/tool/timestamp。预置历史行不写本轮 marker
      // （shim 收到 stdin 后才逐字追加本轮 user 行）。
      // cwd 既在顶层字段也出现在 toolUseResult.prompt 文本里，逐字替换占位 cwd
      // （仅路径替换，不动 usage/model/time）。
      const mainRaw = readFileSync(join(REAL_NATIVE_FIXTURE_DIR, 'claude-main.jsonl'), 'utf8')
        .replaceAll('/workspace/test-sandbox', sourceRepo);
      const mainLines = mainRaw.trim().split('\n').map(line => {
        const obj = JSON.parse(line);
        obj.sessionId = pinned;
        obj.cwd = sourceRepo;
        if (obj.toolUseResult && typeof obj.toolUseResult === 'object') {
          obj.toolUseResult.agentId = nativeAgentId;
        }
        return JSON.stringify(obj);
      });
      writeFileSync(mainPath, mainLines.join('\n') + '\n', 'utf8');

      // 真实子流日志：定点关联主流 agentId、共享 sessionId 与实例 cwd
      const subRaw = readFileSync(join(REAL_NATIVE_FIXTURE_DIR, 'claude-subagent.jsonl'), 'utf8')
        .replaceAll('/workspace/test-sandbox', sourceRepo);
      const subLines = subRaw.trim().split('\n').map(line => {
        const obj = JSON.parse(line);
        obj.sessionId = pinned;
        obj.agentId = nativeAgentId;
        obj.cwd = sourceRepo;
        return JSON.stringify(obj);
      });
      writeFileSync(subagentPath, subLines.join('\n') + '\n', 'utf8');

    } else if (client === 'codex') {
      const sessionsDir = join(codexHome, 'sessions', '2026', '10', '03');
      mkdirSync(sessionsDir, { recursive: true });
      mainPath = join(sessionsDir, `rollout-2026-10-03-02-45-40-${nativeSessionId}.jsonl`);

      const codexRaw = readFileSync(join(REAL_NATIVE_FIXTURE_DIR, 'codex.jsonl'), 'utf8');
      const codexLines = codexRaw.trim().split('\n').map(line => {
        const obj = JSON.parse(line);
        if (obj.type === 'session_meta' && obj.payload) {
          obj.payload.id = nativeSessionId;
          obj.payload.session_id = nativeSessionId;
          obj.payload.cwd = sourceRepo;
          obj.payload.runtime_workspace_roots = [sourceRepo];
        }
        return JSON.stringify(obj);
      });
      writeFileSync(mainPath, codexLines.join('\n') + '\n', 'utf8');

      // shim 读取的当前 rollout 清单
      writeFileSync(join(codexHome, '.insight-current.json'), JSON.stringify({ current: mainPath }), 'utf8');

      // history 持久 marker 证明（resolver 反查锚点）
      appendFileSync(
        join(codexHome, 'history.jsonl'),
        JSON.stringify({ session_id: nativeSessionId, ts: Math.floor(Date.now() / 1000), text: submittedText }) + '\n',
        'utf8'
      );

    } else if (client === 'traex') {
      const cliDir = join(traeHome, 'cli');
      const sessionsDir = join(cliDir, 'sessions', '2026', '10', '03');
      mkdirSync(sessionsDir, { recursive: true });
      mainPath = join(sessionsDir, `rollout-2026-10-03-02-45-07-${nativeSessionId}.jsonl`);

      const traexRaw = readFileSync(join(REAL_NATIVE_FIXTURE_DIR, 'traex.jsonl'), 'utf8');
      const traexLines = traexRaw.trim().split('\n').map(line => {
        const obj = JSON.parse(line);
        if (obj.type === 'session_meta' && obj.payload) {
          obj.payload.id = nativeSessionId;
          obj.payload.session_id = nativeSessionId;
          obj.payload.cwd = sourceRepo;
        }
        return JSON.stringify(obj);
      });
      writeFileSync(mainPath, traexLines.join('\n') + '\n', 'utf8');

      mkdirSync(cliDir, { recursive: true });
      writeFileSync(join(cliDir, '.insight-current.json'), JSON.stringify({ current: mainPath }), 'utf8');

      appendFileSync(
        join(cliDir, 'history.jsonl'),
        JSON.stringify({ session_id: nativeSessionId, ts: Math.floor(Date.now() / 1000), text: submittedText }) + '\n',
        'utf8'
      );
    }

    // 经真实 PTY 投递 prompt（driver 自行前置 marker），等待真实任务完成。
    const sendRes = await instance.request('POST', `/api/sessions/${sessionId}/send`, {
      prompt,
      mode: 'queue'
    });
    if (sendRes.status !== 202) {
      throw new Error(`Failed to send prompt to session ${sessionId}: ${sendRes.text}`);
    }
    const taskId = sendRes.json.task.id;

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const [sessionRes, tasksRes] = await Promise.all([
        instance.request('GET', `/api/sessions/${sessionId}`),
        instance.request('GET', `/api/sessions/${sessionId}/tasks`)
      ]);
      const tasks = Array.isArray(tasksRes.json) ? tasksRes.json : [];
      const targetTask = tasks.find((t: any) => t.id === taskId);
      if (sessionRes.json?.state === 'idle' && targetTask?.status === 'completed') {
        break;
      }
      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 150));
    }

    // 终态校验
    const finalSession = await instance.request('GET', `/api/sessions/${sessionId}`);
    const finalTasks = await instance.request('GET', `/api/sessions/${sessionId}/tasks`);
    const finalTask = (Array.isArray(finalTasks.json) ? finalTasks.json : []).find((t: any) => t.id === taskId);

    if (finalSession.json?.state !== 'idle' || finalTask?.status !== 'completed') {
      throw new Error(
        `Session ${sessionId} task ${taskId} did not complete within timeout. State: ${finalSession.json?.state}, Task status: ${finalTask?.status}. Server logs:\n${instance.serverLog.join('')}`
      );
    }

    return {
      sessionId,
      nativeSessionId,
      nativeAgentId,
      mainPath,
      subagentPath
    };
  };

  return {
    instance,
    claudeDataDir,
    codexHome,
    traeHome,
    assetsDir,
    createSession
  };
}
