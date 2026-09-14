import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './harness.js';

test.describe('Core smoke verification', () => {
  let activeChildScope: {
    child: ChildProcess;
    kill: () => Promise<void>;
  } | null = null;

  test.afterEach(async () => {
    if (activeChildScope) {
      await activeChildScope.kill();
      activeChildScope = null;
    }
  });

  test('runs 67-assertion end-to-end smoke with isolated tmux and server', async ({}, testInfo) => {
    test.setTimeout(180_000);

    const artifactDir = testInfo.config.metadata?.artifactDir
      ? join(testInfo.config.metadata.artifactDir, 'smoke')
      : testInfo.outputDir;
    mkdirSync(artifactDir, { recursive: true });

    const smokeScript = join(REPO_ROOT, 'scripts/e2e-smoke.mjs');
    let childExited = false;
    let exitCode: number | null = null;
    const stdout: string[] = [];
    const stderr: string[] = [];

    const child = spawn(
      process.execPath,
      [smokeScript, '--port', '0', '--artifact-dir', artifactDir],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DUTYDECK_E2E_ARTIFACT_DIR: artifactDir
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      }
    );

    let cleanupPromise: Promise<void> | null = null;
    const killChildSafely = async (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        if (childExited) return;
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            try {
              child.kill('SIGTERM');
            } catch {}
          }
        }

        const deadline = Date.now() + 8_000;
        while (!childExited && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 100));
        }

        if (!childExited && child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {}
          }
        }
      })();
      return cleanupPromise;
    };

    activeChildScope = { child, kill: killChildSafely };

    child.stdout?.on('data', chunk => {
      stdout.push(String(chunk));
    });
    child.stderr?.on('data', chunk => {
      stderr.push(String(chunk));
    });

    const onProcessSignal = () => {
      void killChildSafely();
    };
    process.once('SIGINT', onProcessSignal);
    process.once('SIGTERM', onProcessSignal);

    try {
      const exitPromise = new Promise<number | null>(resolveExit => {
        child.on('exit', code => {
          childExited = true;
          resolveExit(code);
        });
      });

      // 给子进程设置早于测试超时的有界预算（150s），留出充足预算给取证和资源回收
      const childDeadlineTimeout = 150_000;
      const timerPromise = new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`e2e-smoke.mjs 未在 ${childDeadlineTimeout}ms 内完成`)), childDeadlineTimeout);
        t.unref();
      });

      exitCode = await Promise.race([exitPromise, timerPromise]);
    } finally {
      process.removeListener('SIGINT', onProcessSignal);
      process.removeListener('SIGTERM', onProcessSignal);

      const serverLogPath = join(artifactDir, 'server.log');
      if (existsSync(serverLogPath)) {
        await testInfo.attach('smoke-server.log', {
          path: serverLogPath,
          contentType: 'text/plain'
        });
      }

      const smokeResultsPath = join(artifactDir, 'smoke-results.json');
      if (existsSync(smokeResultsPath)) {
        await testInfo.attach('smoke-results.json', {
          path: smokeResultsPath,
          contentType: 'application/json'
        });
      }

      const failureScreenshotPath = join(artifactDir, 'smoke-failure.png');
      if (existsSync(failureScreenshotPath)) {
        await testInfo.attach('smoke-failure.png', {
          path: failureScreenshotPath,
          contentType: 'image/png'
        });
      }

      const tracePath = join(artifactDir, 'smoke-trace.zip');
      if (existsSync(tracePath)) {
        await testInfo.attach('smoke-trace.zip', {
          path: tracePath,
          contentType: 'application/zip'
        });
      }
    }

    if (exitCode !== 0) {
      console.error('Smoke failed with stdout:\n', stdout.join(''));
      console.error('Smoke failed with stderr:\n', stderr.join(''));
    }

    expect(exitCode).toBe(0);
    expect(stdout.join('')).toContain('67 项断言全部成立');
  });
});
