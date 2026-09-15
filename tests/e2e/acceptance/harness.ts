import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

export const REPO_ROOT = resolve(__dirname, '../../..');
const SERVER_ENTRY = join(REPO_ROOT, 'apps/server/dist/cli.js');

const POLLUTING_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN'
];

export async function getAvailablePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', rejectPort);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolvePort(port));
    });
  });
}

export function writeMockCli(binDir: string, claudeDataDir: string): string {
  const path = join(binDir, 'mock-claude');
  writeFileSync(
    path,
    `#!/usr/bin/env node
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

process.stdout.write('Claude Code v2.1.267 (mock)' + (resumed ? ' (resumed)' : '') + '\\r\\n\\u276f ');

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
    process.stdout.write('\\u001b[2J\\u001b[HClaude Code v2.1.267 (mock)\\r\\n\\u2733 Worked for 1s\\r\\n\\u276f ');
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
`,
    { mode: 0o755 }
  );
  return path;
}

export interface TestServerInstance {
  dataDir: string;
  sourceRepo: string;
  serverHome: string;
  binDir: string;
  socket: string;
  port: number;
  baseUrl: string;
  serverLog: string[];
  server: ChildProcess;
  cleanup: () => Promise<void>;
  request: (method: string, path: string, body?: unknown) => Promise<{ status: number; headers: Headers; json?: any; text: string }>;
}

export async function launchIsolatedTestServer(prefix = 'dutydeck-acc-'): Promise<TestServerInstance> {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  const serverHome = join(dataDir, 'home');
  const binDir = join(dataDir, 'bin');
  const claudeDataDir = join(dataDir, 'claude');
  const tmuxTmpDir = join(dataDir, 'tmux-tmp');
  const sourceRepo = join(dataDir, 'source-repo');
  const socket = join(dataDir, 'tmux.sock');

  let server: ChildProcess | undefined;
  let serverExited = false;
  let exitCode: number | null = null;
  const serverLog: string[] = [];
  let tmuxBin = 'tmux';

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = async (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (server?.pid && !serverExited) {
        try {
          process.kill(-server.pid, 'SIGTERM');
        } catch {
          try {
            server.kill('SIGTERM');
          } catch {}
        }

        const killDeadline = Date.now() + 5_000;
        while (!serverExited && Date.now() < killDeadline) {
          await new Promise(r => setTimeout(r, 100));
        }

        if (!serverExited) {
          try {
            process.kill(-server.pid, 'SIGKILL');
          } catch {
            try {
              server.kill('SIGKILL');
            } catch {}
          }
        }
      }

      try {
        execFileSync(tmuxBin, ['-S', socket, 'kill-server'], { stdio: 'ignore' });
      } catch {}

      try {
        if (existsSync(dataDir)) {
          rmSync(dataDir, { recursive: true, force: true });
        }
      } catch {}
    })();
    return cleanupPromise;
  };

  try {
    for (const dir of [serverHome, binDir, claudeDataDir, tmuxTmpDir, sourceRepo]) {
      mkdirSync(dir, { recursive: true });
    }

    // 初始化真实 Git 源码仓库，包含 baseline 提交
    const git = (args: string[]) => execFileSync('git', ['-C', sourceRepo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '-q']);
    git(['config', 'user.name', 'AcceptanceTest']);
    git(['config', 'user.email', 'acceptance@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(sourceRepo, 'tracked.txt'), 'baseline content\n', 'utf8');
    git(['add', '.']);
    git(['commit', '-qm', 'initial baseline']);

    // 生成私有 tmux shim 与私有 socket
    tmuxBin = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
    const quote = (v: string) => "'" + v.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(binDir, 'tmux'), `#!/bin/sh\nexec ${quote(tmuxBin)} -S ${quote(socket)} "$@"\n`, { mode: 0o755 });

    // 生成 mock CLI
    const mockCliPath = writeMockCli(binDir, claudeDataDir);

    const serverEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of POLLUTING_ENV) delete serverEnv[k];
    serverEnv.NODE_ENV = 'production';
    serverEnv.PATH = `${binDir}:${process.env.PATH || ''}`;
    serverEnv.HOME = serverHome;
    serverEnv.TMUX_TMPDIR = tmuxTmpDir;

    const mockAgent = {
      id: 'claude-code',
      name: 'Mock Claude',
      command: mockCliPath,
      args: [],
      protocol: 'pty-cli',
      cwd: sourceRepo,
      env: { CLAUDE_CONFIG_DIR: claudeDataDir, MOCK_CLAUDE_DATA_DIR: claudeDataDir },
      permissionMode: 'full-trust',
      timeout: 600,
      capabilities: { pause: false, resume: true },
      builtin: false,
      version: 'mock-1.0'
    };
    serverEnv.DUTYDECK_AGENTS_JSON = JSON.stringify([mockAgent]);

    const port = await getAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    server = spawn(
      process.execPath,
      [
        SERVER_ENTRY,
        '--local-only',
        '--port',
        String(port),
        '--cwd',
        sourceRepo,
        '--database',
        join(dataDir, 'dutydeck.db'),
        '--no-lark-listen'
      ],
      {
        cwd: sourceRepo,
        env: serverEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      }
    );

    let serverStdout = '';
    server.stdout?.on('data', chunk => {
      const text = String(chunk);
      serverStdout += text;
      serverLog.push(text);
    });
    server.stderr?.on('data', chunk => {
      serverLog.push(String(chunk));
    });

    server.on('exit', code => {
      serverExited = true;
      exitCode = code;
    });

    // 等待 server 自己输出 listening（必须来自 stdout 中的完整成功监听串 + 本轮端口）
    const deadline = Date.now() + 30_000;
    let listened = false;
    while (Date.now() < deadline) {
      if (serverExited) {
        throw new Error(`Server process exited prematurely with code ${exitCode}:\n${serverLog.join('')}`);
      }
      if (serverStdout.includes('Dutydeck UI and API listening on') && serverStdout.includes(String(port))) {
        listened = true;
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    if (!listened) {
      throw new Error(`Server did not log listening on port ${port} within 30s. Logs:\n${serverLog.join('')}`);
    }

    // 确认 /health 就绪
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.status === 200) {
          const json = await res.json() as any;
          if (json?.ok) {
            healthy = true;
            break;
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 150));
    }

    if (!healthy) {
      throw new Error(`Server healthcheck failed on ${baseUrl}/health. Logs:\n${serverLog.join('')}`);
    }

    const request = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {}
      return { status: res.status, headers: res.headers, json, text };
    };

    return {
      dataDir,
      sourceRepo,
      serverHome,
      binDir,
      socket,
      port,
      baseUrl,
      serverLog,
      server,
      cleanup,
      request
    };
  } catch (err) {
    await cleanup();
    const message = err instanceof Error ? err.message : String(err);
    const detail = serverLog.length ? `\nServer stdout/stderr:\n${serverLog.join('')}` : '';
    throw new Error(`launchIsolatedTestServer failed: ${message}${detail}`, { cause: err });
  }
}
