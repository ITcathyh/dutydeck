#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createCliProgram, environmentFromCli, type CliOptions } from './cli-program.js';
import { startLocalServer } from './service.js';
import { runLarkSend, runLarkUpdate } from './lark/cli.js';
import { acpkPassThroughArgs, runAcpk } from './acpk.js';
import { AgentGroupToolCliError, runGroupBots, runGroupMembers, runGroupMessage, runGroupMessages, runGroupPeers, runGroupSelf, runGroupSend, runGroupWait } from './lark/agent-tools-cli.js';
import { askOutput, runSessionAsk, runSessionSend } from './relay-cli.js';
import { RelayCliError } from '@dockmux/relay';
import { dockmuxGroupToolsCommand } from './lark/agent-tools.js';
import { daemonRestart, daemonStart, daemonStatus, daemonStop } from './daemon/command.js';
import { readDaemonStatus, resolveDaemonDir } from './daemon/daemon.js';
import { sleep } from './daemon/time.js';
import { runNpmForDockmuxUpdate, updateDockmux } from './update.js';
import { loadConfig } from '@dockmux/config';
import { createRepositories } from '@dockmux/storage';
import { runAuthTokenCommand } from './auth/auth.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };

try { loadEnvFile(); } catch {}

async function serve(options: CliOptions, onReady?: () => void) {
  const service = await startLocalServer({ env: environmentFromCli(options), groupToolsCommand: dockmuxGroupToolsCommand(fileURLToPath(import.meta.url)) });
  const address = service.config.host === '0.0.0.0'
    ? `http://127.0.0.1:${service.config.port} (LAN access enabled; other devices can use this computer's LAN IP)`
    : `http://${service.config.host.includes(':') ? `[${service.config.host}]` : service.config.host}:${service.config.port}`;
  process.stdout.write(`Dockmux UI and API listening on ${address}\n`);
  onReady?.();
  let closing = false;
  let hardStop: NodeJS.Timeout | undefined;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (closing) {
      process.stderr.write(`Received ${signal} again; forcing exit.\n`);
      process.exit(130);
    }
    closing = true;
    process.stdout.write('Shutting down Dockmux… Press Ctrl-C again to force exit.\n');
    hardStop = setTimeout(() => {
      process.stderr.write('Shutdown exceeded 5 seconds; forcing exit.\n');
      process.exit(1);
    }, 5_000);
    try {
      await service.close();
      clearTimeout(hardStop);
      process.exit(0);
    } catch (error) {
      clearTimeout(hardStop);
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Observe fatal errors without installing a recovery handler. Continuing
  // after an uncaught exception can leave the DB, PTY, and session queues in an
  // unknown state; Node must retain its default non-zero exit behavior so the
  // runner/daemon supervisor can start a clean process. Unhandled rejections
  // reach this monitor through Node's default `throw` mode as well.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    process.stderr.write(`Fatal ${origin}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  });
}

async function restartWithInstalledCli(entrypoint: string) {
  if (!existsSync(entrypoint)) throw new Error(`Updated Dockmux entrypoint was not found: ${entrypoint}. The service was not restarted.`);
  const previousPid = daemonStatus().pid;
  const child = spawn(process.execPath, [entrypoint, 'daemon', 'restart'], { stdio: 'inherit', env: process.env });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Dockmux restart exited with code ${code ?? 'unknown'}.`)));
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = daemonStatus();
    if (status.running && status.ready && status.pid && status.pid !== previousPid) return;
    await sleep(200);
  }
  throw new Error('Dockmux was updated, but the restarted service did not become ready within 15 seconds. Run dockmux status and inspect the daemon log.');
}

async function main() {
  const acpkArgs = acpkPassThroughArgs(process.argv);
  if (acpkArgs) {
    process.exitCode = await runAcpk(acpkArgs);
    return;
  }
  const output = (result: unknown) => process.stdout.write(`${JSON.stringify({ ok: true, ...result as object })}\n`);
  const daemonServe: (options: CliOptions, onReady?: () => void) => Promise<void> = (options, onReady) => serve(options, onReady);
  const program = createCliProgram(packageJson.version, {
    serve,
    daemonStart: async options => {
      const result = await daemonStart(options, { serve: daemonServe });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    },
    daemonStop: async () => {
      const result = await daemonStop();
      process.stdout.write(`${JSON.stringify(result)}\n`);
    },
    daemonRestart: async options => {
      const result = await daemonRestart(options, { serve: daemonServe });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    },
    daemonStatus: () => {
      const status = daemonStatus();
      process.stdout.write(`${JSON.stringify({ ok: true, action: 'status', ...status })}\n`);
    },
    update: async options => {
      output(await updateDockmux(packageJson.version, options, {
        packageName: packageJson.name,
        runNpm: runNpmForDockmuxUpdate,
        restart: restartWithInstalledCli
      }));
    },
    authToken: async options => {
      // 优先用运行中/上次 daemon 记录的数据库路径，保证查看/轮换的是同一个 token；
      // daemon 从未运行过时回退到 loadConfig 的默认解析（<cwd>/.dockmux/dockmux.db）。
      const databaseUrl = readDaemonStatus(resolveDaemonDir())?.database ?? loadConfig(process.env).databaseUrl;
      const repos = createRepositories(databaseUrl);
      try {
        output(await runAuthTokenCommand(repos.config, { rotate: options.rotate === true }));
      } finally {
        repos.close();
      }
    },
    larkSend: async (markdown, options) => { output(await runLarkSend(markdown, options)); },
    larkUpdate: async (markdown, options) => { output(await runLarkUpdate(markdown, options)); },
    groupSelf: async () => { output(await runGroupSelf()); },
    groupPeers: async () => { output(await runGroupPeers()); },
    groupMembers: async () => { output(await runGroupMembers()); },
    groupBots: async () => { output(await runGroupBots()); },
    groupMessages: async options => { output(await runGroupMessages(options)); },
    groupMessage: async messageId => { output(await runGroupMessage(messageId)); },
    groupSend: async (content, options) => { output(await runGroupSend(content, options)); },
    groupWait: async options => { output(await runGroupWait(options)); },
    sessionSend: async text => { output(await runSessionSend(text)); },
    sessionAsk: async (question, options) => {
      // ask 有自己的 stdout/退出码契约（答案裸文本走 stdout，提示走 stderr），
      // 不能套用通用的 output()：调用方要能 `answer=$(dockmux session ask ...)`。
      const result = await runSessionAsk(question, options);
      const rendered = askOutput(result, options.json === true);
      if (rendered.stdout) process.stdout.write(rendered.stdout);
      if (rendered.stderr) process.stderr.write(rendered.stderr);
      process.exitCode = rendered.exitCode;
    }
  });
  await program.parseAsync();
}

try {
  await main();
} catch (error) {
  if (error instanceof AgentGroupToolCliError) process.stderr.write(`${JSON.stringify({ ok: false, error: error.error })}\n`);
  else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  // relay 的 CLI 错误自带退出码契约（2 用法 / 3 通道不可用），不能一律压成 1
  process.exit(error instanceof RelayCliError ? error.exitCode : 1);
}
