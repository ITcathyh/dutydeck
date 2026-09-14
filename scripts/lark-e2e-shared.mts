import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Browser, BrowserContext } from '@playwright/test';

const pExecFile = promisify(execFile);

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout of ${ms}ms exceeded: ${label}`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface E2ERunMetadata {
  scenario: string;
  boundary: 'synthetic_lark';
  testedAt: string;
  gitCommit: string;
  gitDirty: boolean;
  node: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  [key: string]: unknown;
}

export async function resolveArtifactDir(scenario: string): Promise<string> {
  const envDir = process.env.DUTYDECK_E2E_ARTIFACT_DIR;
  let artifactDir: string;
  if (envDir && envDir.trim()) {
    artifactDir = resolve(envDir.trim());
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    artifactDir = resolve('artifacts/e2e', `${scenario}-${timestamp}-${process.pid}`);
  }
  await mkdir(artifactDir, { recursive: true });
  return artifactDir;
}

export async function getGitMetadata(): Promise<{ commit: string; dirty: boolean }> {
  try {
    const { stdout: commitOut } = await pExecFile('git', ['rev-parse', 'HEAD']);
    const { stdout: statusOut } = await pExecFile('git', ['status', '--porcelain']);
    return {
      commit: commitOut.trim(),
      dirty: statusOut.trim().length > 0,
    };
  } catch {
    return {
      commit: 'unknown',
      dirty: false,
    };
  }
}

export class ArtifactLogger {
  private readonly logPath: string;
  private readonly originalStdoutWrite = process.stdout.write.bind(process.stdout);
  private readonly originalStderrWrite = process.stderr.write.bind(process.stderr);
  private logBuffer: string[] = [];

  constructor(artifactDir: string) {
    this.logPath = resolve(artifactDir, 'run.log');
    this.install();
  }

  private install() {
    process.stdout.write = ((chunk: any, encoding?: any, cb?: any) => {
      this.logBuffer.push(typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8'));
      return this.originalStdoutWrite(chunk, encoding, cb);
    }) as any;

    process.stderr.write = ((chunk: any, encoding?: any, cb?: any) => {
      this.logBuffer.push(typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8'));
      return this.originalStderrWrite(chunk, encoding, cb);
    }) as any;
  }

  async flush(): Promise<void> {
    try {
      await writeFile(this.logPath, this.logBuffer.join(''), 'utf8');
    } catch {
      // Best-effort flush
    }
  }

  uninstall() {
    process.stdout.write = this.originalStdoutWrite;
    process.stderr.write = this.originalStderrWrite;
  }
}

export async function captureBrowserArtifacts(
  browser: Browser | undefined,
  context: BrowserContext | undefined,
  artifactDir: string,
  options: { isFailure?: boolean } = {}
): Promise<void> {
  const prefix = options.isFailure ? 'failure' : 'finish';
  if (context) {
    try {
      const pages = context.pages();
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        if (page && !page.isClosed()) {
          const path = resolve(artifactDir, `${prefix}-page-${i}.png`);
          await withTimeout(page.screenshot({ path, fullPage: true }).catch(() => {}), 5_000, 'screenshot');
        }
      }
    } catch {
      // best-effort
    }
    try {
      const tracePath = resolve(artifactDir, 'trace.zip');
      await withTimeout(context.tracing.stop({ path: tracePath }).catch(() => {}), 10_000, 'trace.stop');
    } catch {
      // best-effort
    }
  }
}

export interface TerminationController {
  readonly terminated: boolean;
  readonly error: Error | undefined;
  checkAborted(): void;
  trigger(err: Error): void;
  dispose(): void;
}

/**
 * Single bounded termination path for SIGINT / SIGTERM / global timeout. trigger() actively runs the
 * supplied handler (evidence -> cleanup -> failure result) and exits non-zero; a hard backstop
 * force-exits if graceful termination exceeds its bound. No generic cancellation framework.
 */
export function installTermination(
  label: string,
  timeoutMs: number,
  handleTermination: (err: Error) => Promise<{ cleanupFailed?: boolean }>
): TerminationController {
  const state = { terminated: false, error: undefined as Error | undefined };
  let handling = false;
  let hardExitTimer: NodeJS.Timeout | undefined;

  const trigger = (err: Error) => {
    if (state.terminated) return;
    state.terminated = true;
    state.error = err;
    if (handling) return;
    handling = true;
    console.error(`Terminating ${label}: ${err.message}`);
    hardExitTimer = setTimeout(() => {
      console.error(`Force exit: ${label} graceful termination exceeded its bound`);
      process.exit(1);
    }, 30_000);
    hardExitTimer.unref();
    void handleTermination(err)
      .then(
        result => process.exit(result?.cleanupFailed ? 1 : 1),
        () => process.exit(1)
      );
  };

  const onSignal = (signal: string) => trigger(new Error(`Terminated by ${signal}`));
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  const timer = setTimeout(() => trigger(new Error(`Global timeout of ${timeoutMs}ms exceeded in ${label}`)), timeoutMs);
  timer.unref();

  return {
    get terminated() { return state.terminated; },
    get error() { return state.error; },
    checkAborted() { if (state.terminated) throw state.error ?? new Error('Execution aborted'); },
    trigger,
    dispose() { clearTimeout(timer); if (hardExitTimer) clearTimeout(hardExitTimer); },
  };
}
