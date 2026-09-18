import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(checkDirectory, '../../../..');

function isolatedCommand(env, command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    env,
    encoding: options.encoding,
    stdio: options.stdio,
  });
}

function isolatedSessions(env) {
  const result = isolatedCommand(env, 'tmux', ['list-sessions', '-F', '#{session_name}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

function print(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function main() {
  const privateRoot = mkdtempSync(join(tmpdir(), 'dutydeck-parity-wp2-'));
  const runtimeTmp = join(privateRoot, 'runtime');
  const tmuxTmp = join(privateRoot, 'tmux');
  mkdirSync(runtimeTmp, { mode: 0o700 });
  mkdirSync(tmuxTmp, { mode: 0o700 });
  if (process.platform !== 'win32') {
    chmodSync(privateRoot, 0o700);
    chmodSync(runtimeTmp, 0o700);
    chmodSync(tmuxTmp, 0o700);
  }

  const env = {
    ...process.env,
    TMPDIR: runtimeTmp,
    TMUX_TMPDIR: tmuxTmp,
  };
  delete env.TMUX;

  let testStatus = 1;
  let residue = [];
  try {
    const tmuxVersion = isolatedCommand(env, 'tmux', ['-V'], { stdio: 'ignore' });
    if (tmuxVersion.status !== 0) {
      print({
        case_id: 'daemon-restart-owned-run-reattach',
        status: 'skip',
        reason_code: 'TMUX_UNAVAILABLE',
      });
      return 77;
    }

    const test = isolatedCommand(env, process.execPath, [
      'node_modules/vitest/vitest.mjs', 'run',
      'apps/server/src/service.test.ts',
      '--project', 'node',
      '-t', 'keeps a completed Dutydeck Run on the same pane across a service restart',
    ], { stdio: 'inherit' });
    testStatus = test.status ?? 1;
    residue = isolatedSessions(env);

    if (testStatus === 0 && residue.length === 0) {
      print({
        case_id: 'daemon-restart-owned-run-reattach',
        status: 'pass',
        sqlite_isolated: true,
        tmux_namespace_isolated: true,
        tmux_residual_sessions: 0,
        same_pane_pid_asserted_by_service_test: true,
        final_stop_destroy_asserted_by_service_test: true,
      });
      return 0;
    }

    print({
      case_id: 'daemon-restart-owned-run-reattach',
      status: 'fail',
      error_code: residue.length > 0 ? 'ISOLATED_TMUX_RESIDUE' : 'WP2_SERVICE_TEST_FAILED',
      tmux_residual_sessions: residue.length,
    }, process.stderr);
    return 1;
  } finally {
    isolatedCommand(env, 'tmux', ['kill-server'], { stdio: 'ignore' });
    rmSync(privateRoot, { recursive: true, force: true });
  }
}

process.exitCode = main();
