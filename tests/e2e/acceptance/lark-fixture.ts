import { test as base, type TestInfo } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');

interface ScenarioResult {
  passed?: boolean;
  error?: string;
}

function resolvePlaywrightBrowsersPath(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH.trim()) {
    return process.env.PLAYWRIGHT_BROWSERS_PATH.trim();
  }
  const xdgCache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(xdgCache, 'ms-playwright');
}

function buildIsolatedEnv(tempDir: string, artifactDir: string, extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const dirs = {
    home: join(tempDir, 'home'),
    tmp: join(tempDir, 'tmp'),
    config: join(tempDir, 'config'),
    data: join(tempDir, 'data'),
    tmux: join(tempDir, 'tmux'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|LARK_|FEISHU_|DUTYDECK_LARK_)/.test(key)) delete env[key];
  }
  delete env.DUTYDECK_AGENTS_JSON;

  env.HOME = dirs.home;
  env.TMPDIR = dirs.tmp;
  env.TMP = dirs.tmp;
  env.TEMP = dirs.tmp;
  env.XDG_CONFIG_HOME = dirs.config;
  env.XDG_DATA_HOME = dirs.data;
  env.TMUX_TMPDIR = dirs.tmux;

  env.PLAYWRIGHT_BROWSERS_PATH = resolvePlaywrightBrowsersPath();
  env.DUTYDECK_E2E_ARTIFACT_DIR = artifactDir;

  return extraEnv ? { ...env, ...extraEnv } : env;
}

async function attachArtifacts(testInfo: TestInfo, artifactDir: string, stdout: string, stderr: string): Promise<void> {
  if (stdout) await testInfo.attach('lark-stdout.log', { body: stdout, contentType: 'text/plain' });
  if (stderr) await testInfo.attach('lark-stderr.log', { body: stderr, contentType: 'text/plain' });

  const files: Array<[string, string]> = [
    ['result.json', 'application/json'],
    ['run.log', 'text/plain'],
    ['trace.zip', 'application/zip'],
  ];
  for (const [file, contentType] of files) {
    const path = join(artifactDir, file);
    if (existsSync(path)) await testInfo.attach(file, { path, contentType });
  }

  if (existsSync(artifactDir)) {
    for (const entry of readdirSync(artifactDir)) {
      if (entry.endsWith('.png')) {
        await testInfo.attach(entry, { path: join(artifactDir, entry), contentType: 'image/png' });
      }
    }
  }
}

export interface RunLarkScenarioOptions {
  scriptName: string;
  extraEnv?: Record<string, string>;
}

export const test = base.extend<{ runLarkScenario: (options: RunLarkScenarioOptions) => Promise<void> }>({
  runLarkScenario: async ({}, use, testInfo) => {
    let activeCleanup: (() => Promise<void>) | undefined;

    const runLarkScenario = async (options: RunLarkScenarioOptions) => {
      const artifactDir = testInfo.outputPath('scenario');
      mkdirSync(artifactDir, { recursive: true });

      const scriptPath = join(REPO_ROOT, 'scripts', options.scriptName);
      if (!existsSync(scriptPath)) throw new Error(`Synthetic lark script not found: ${scriptPath}`);

      let tempDir: string | undefined;
      let pgid: number | undefined;
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let deadlineTimer: NodeJS.Timeout | undefined;
      let timeoutError: Error | undefined;
      let cleanupPromise: Promise<void> | undefined;
      let attached = false;

      const isGroupAlive = () => {
        if (!pgid) return false;
        try {
          process.kill(-pgid, 0);
          return true;
        } catch (err: any) {
          return err.code !== 'ESRCH';
        }
      };

      const terminateGroup = async () => {
        if (!pgid) return;
        // 无论 direct child 是否 exit，检查进程组内是否有活跃子/孙进程存活
        if (isGroupAlive()) {
          try { process.kill(-pgid, 'SIGTERM'); } catch {}
          const termDeadline = Date.now() + 15_000;
          while (isGroupAlive() && Date.now() < termDeadline) {
            await new Promise(r => setTimeout(r, 100));
          }
        }
        if (isGroupAlive()) {
          try { process.kill(-pgid, 'SIGKILL'); } catch {}
          const killDeadline = Date.now() + 5_000;
          while (isGroupAlive() && Date.now() < killDeadline) {
            await new Promise(r => setTimeout(r, 100));
          }
        }
        if (isGroupAlive()) {
          throw new Error(`Process group -${pgid} still has alive processes after SIGKILL`);
        }
      };

      const safeAttach = async () => {
        if (attached) return;
        attached = true;
        await attachArtifacts(testInfo, artifactDir, stdout, stderr);
      };

      const cleanup = async () => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
          if (deadlineTimer) {
            clearTimeout(deadlineTimer);
            deadlineTimer = undefined;
          }
          process.removeListener('SIGINT', onSignal);
          process.removeListener('SIGTERM', onSignal);

          try {
            await terminateGroup();
          } finally {
            try {
              await safeAttach();
            } catch {}
            if (tempDir && existsSync(tempDir)) {
              rmSync(tempDir, { recursive: true, force: true });
            }
          }
        })();
        return cleanupPromise;
      };

      const onSignal = () => { void cleanup(); };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      activeCleanup = cleanup;

      try {
        tempDir = mkdtempSync(join(tmpdir(), 'dutydeck-lark-'));
        const childEnv = buildIsolatedEnv(tempDir, artifactDir, options.extraEnv);

        const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
          cwd: REPO_ROOT,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });

        if (!child.pid) {
          throw new Error(`Failed to spawn ${options.scriptName}`);
        }
        pgid = child.pid;

        child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr?.on('data', chunk => { stderr += chunk.toString(); });

        const exitPromise = new Promise<void>((resolveExit, rejectExit) => {
          child.on('exit', (code, signal) => {
            exitCode = code;
            exitSignal = signal;
            resolveExit();
          });
          child.on('error', err => {
            exitCode = -1;
            rejectExit(err);
          });
        });

        const testTimeout = testInfo.timeout > 0 ? testInfo.timeout : 180_000;
        const childDeadlineMs = Math.max(testTimeout - 30_000, 1_000);
        deadlineTimer = setTimeout(() => {
          timeoutError = new Error(`Child deadline of ${childDeadlineMs}ms exceeded for ${options.scriptName}`);
          void cleanup();
        }, childDeadlineMs);

        await exitPromise;
      } finally {
        await cleanup();
      }

      // 超时原因不可被覆盖：优先抛出超时失败
      if (timeoutError) {
        throw timeoutError;
      }

      if (exitCode !== 0) {
        throw new Error(`${options.scriptName} exited with code ${exitCode} (signal ${exitSignal})`);
      }

      const resultPath = join(artifactDir, 'result.json');
      if (!existsSync(resultPath)) throw new Error(`${options.scriptName} did not write result.json`);

      let result: ScenarioResult;
      try {
        result = JSON.parse(readFileSync(resultPath, 'utf8')) as ScenarioResult;
      } catch (err) {
        throw new Error(`${options.scriptName} wrote invalid result.json: ${(err as Error).message}`);
      }
      if (result.passed !== true) {
        throw new Error(`${options.scriptName} reported failure: ${result.error || 'passed !== true'}`);
      }
    };

    try {
      await use(runLarkScenario);
    } finally {
      await activeCleanup?.();
    }
  },
});
