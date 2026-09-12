#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createCliProgram, environmentFromCli, type CliOptions } from './cli-program.js';
import { startLocalServer } from './service.js';
import { runLarkSend, runLarkUpdate } from './lark/cli.js';
import { acpkPassThroughArgs, runAcpk } from './acpk.js';
import { runWorkCommand } from './work-item-cli.js';
import { AgentGroupToolCliError, runGroupBots, runGroupMembers, runGroupMessage, runGroupMessages, runGroupPeers, runGroupSelf, runGroupSend, runGroupSendFile, runGroupWait } from './lark/agent-tools-cli.js';
import { askOutput, runSessionAsk, runSessionSend } from './relay-cli.js';
import { RelayCliError } from '@dutydeck/relay';
import { dutydeckGroupToolsCommand } from './lark/agent-tools.js';
import { daemonRestart, daemonStart, daemonStatus, daemonStop, type DaemonCommandResult, type DaemonStatusInfo } from './daemon/command.js';
import { readDaemonStatus, resolveDaemonDir } from './daemon/daemon.js';
import { sleep } from './daemon/time.js';
import { runNpmForDutydeckUpdate, updateDutydeck } from './update.js';
import { loadConfig } from '@dutydeck/config';
import { createRepositories } from '@dutydeck/storage';
import { runAuthTokenCommand } from './auth/auth.js';
import { BotmuxImportError } from '@dutydeck/botmux-importer';
import { BotmuxImportCliError, runBotmuxArchive, runBotmuxDiscover, runBotmuxPlan } from './botmux-import-cli.js';
import { LocalFileSecretProvider, SecretProviderError, secretDirectoryForDatabase } from '@dutydeck/secret-provider';
import { SecretCliError, runSecretList, runSecretRemove, runSecretRotate, runSecretSet, type SecretCliContext } from './secret-cli.js';
import { IdentityPreflightCliError, runIdentityPreflightCli } from './identity-preflight-cli.js';
import { runSetup } from './setup/setup.js';
import { PromptAbortedError, PromptUnavailableError } from './setup/prompts.js';
import { InvalidWorkingDirectoryError } from './setup/detect.js';
import { runDoctor } from './doctor/doctor.js';
import { AutostartError, autostartDisable, autostartEnable, autostartStatus } from './autostart/autostart.js';
import { createCliUi } from './cli-ui.js';
import { adoptLegacyEnv, migrateLegacyBrandDirs } from './legacy-brand.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };

try { loadEnvFile(); } catch {}

// 先把旧状态目录就位，再接管环境变量——否则无从判断变量里改写后的路径是否真的存在。
const legacyState = migrateLegacyBrandDirs();
for (const dir of legacyState.migrated) process.stderr.write(`已接管 dockmux 时期的状态目录：${dir}\n`);
for (const dir of legacyState.skipped) {
  process.stderr.write(`未接管 ${dir}：同级已有 .dutydeck，两份状态都留着，请自行确认用哪一份。\n`);
}
adoptLegacyEnv();

async function serve(options: CliOptions, onReady?: () => void) {
  const service = await startLocalServer({ env: environmentFromCli(options), groupToolsCommand: dutydeckGroupToolsCommand(fileURLToPath(import.meta.url)) });
  const address = service.config.host === '0.0.0.0'
    ? `http://127.0.0.1:${service.config.port} (LAN access enabled; other devices can use this computer's LAN IP)`
    : `http://${service.config.host.includes(':') ? `[${service.config.host}]` : service.config.host}:${service.config.port}`;
  process.stdout.write(`Dutydeck UI and API listening on ${address}\n`);
  onReady?.();
  let closing = false;
  let hardStop: NodeJS.Timeout | undefined;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (closing) {
      process.stderr.write(`Received ${signal} again; forcing exit.\n`);
      process.exit(130);
    }
    closing = true;
    process.stdout.write('Shutting down Dutydeck… Press Ctrl-C again to force exit.\n');
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
  if (!existsSync(entrypoint)) throw new Error(`Updated Dutydeck entrypoint was not found: ${entrypoint}. The service was not restarted.`);
  const previousPid = daemonStatus().pid;
  const child = spawn(process.execPath, [entrypoint, 'daemon', 'restart'], { stdio: 'inherit', env: process.env });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Dutydeck restart exited with code ${code ?? 'unknown'}.`)));
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = daemonStatus();
    if (status.running && status.ready && status.pid && status.pid !== previousPid) return;
    await sleep(200);
  }
  throw new Error('Dutydeck was updated, but the restarted service did not become ready within 15 seconds. Run dutydeck status and inspect the daemon log.');
}

/**
 * start / stop / restart / status 四个命令的统一渲染。
 *
 * 为什么要有它：这四个命令过去直接把 `JSON.stringify(result)` 打进 stdout，于是
 *   · `dutydeck status` 给人看的是一行裸 JSON——而 doctor 的多条 verify 正是让用户跑它；
 *   · `--json` 反而不被接受（unknown option），与 setup / doctor / autostart 的约定相反。
 * 现在与其余命令对齐：默认人类可读，`--json` 才输出单行 JSON。
 *
 * 失败一律带「怎么修」。起不来时最有用的信息是日志路径，所以 logFile 必须露出来。
 */
function renderDaemonResult(result: DaemonCommandResult | (DaemonStatusInfo & { action: 'status' }), json: boolean): void {
  if (json) {
    createCliUi().json({ ok: 'ok' in result ? result.ok : true, ...result });
    return;
  }
  const ui = createCliUi();
  const running = result.running;
  const address = result.address;
  const auth = result.authEnabled === undefined ? undefined : (result.authEnabled ? '认证开启' : '认证关闭');
  const detail = [address, result.pid === undefined ? undefined : `pid ${result.pid}`, auth]
    .filter(Boolean).join(' · ');

  if (result.action === 'status') {
    if (running) {
      ui.status('ok', '守护进程正在运行', detail || undefined);
      if (result.logFile) ui.hint(`日志：${result.logFile}`);
      if (address) ui.hint(`在浏览器打开：${address}`);
    } else {
      ui.status('info', '守护进程未运行');
      ui.hint('启动它：');
      ui.command('dutydeck start');
    }
    return;
  }

  // stop：没在跑也算达成目标，用 ok/info 区分「这次真停了」和「本来就没跑」。
  if (result.action === 'stop') {
    if ('ok' in result && !result.ok) {
      ui.status('fail', '停止失败', result.error);
      ui.hint('确认进程归属后手工处理，或查看日志：');
      if (result.logFile) ui.command(`tail -n 50 ${result.logFile}`);
      return;
    }
    ui.status(result.state === 'not-running' ? 'info' : 'done',
      result.state === 'not-running' ? '守护进程本来就没在运行' : '守护进程已停止',
      result.pid === undefined ? undefined : `pid ${result.pid}`);
    if (result.error) ui.hint(result.error);
    return;
  }

  // start / restart
  if ('ok' in result && !result.ok) {
    if (result.state === 'already-running') {
      // 「已经在跑」不是故障：目标状态已达成，只是这次没动它。
      ui.status('ok', 'Dutydeck 已经在运行中', result.pid === undefined ? undefined : `pid ${result.pid}`);
      ui.hint('要让新的启动参数生效，重启它：');
      ui.command('dutydeck restart');
      ui.hint('验证：dutydeck status');
      return;
    }
    ui.status('fail', result.action === 'restart' ? '重启失败' : '启动失败', result.error);
    ui.hint('多数情况是端口被占用或配置有误，先跑一次体检：');
    ui.command('dutydeck doctor');
    if (result.logFile) ui.hint(`完整日志：${result.logFile}`);
    return;
  }
  ui.status('done', result.action === 'restart' ? '守护进程已重启' : '守护进程已启动', detail || undefined);
  if (address) ui.hint(`在浏览器打开：${address}`);
  if (result.logFile) ui.hint(`日志：${result.logFile}`);
  if (result.error) ui.status('warn', result.error);
  ui.hint('验证：dutydeck status');
}

async function main() {
  const acpkArgs = acpkPassThroughArgs(process.argv);
  if (acpkArgs) {
    process.exitCode = await runAcpk(acpkArgs);
    return;
  }  // 开机项里要写的是「真实的 CLI 入口」。用 import.meta.url 解析到当前正在执行的
  // dist/cli.js，而不是拼 pkgRoot/dist/cli.js——后者在打包成单文件二进制时会指向
  // 一个进程外不存在的虚拟路径，导致开机项静默失效（botmux 踩过这个坑）。
  const autostartOptions = () => ({ cliPath: fileURLToPath(import.meta.url) });
  const output = (result: unknown) => process.stdout.write(`${JSON.stringify({ ok: true, ...result as object })}\n`);
  const daemonServe: (options: CliOptions, onReady?: () => void) => Promise<void> = (options, onReady) => serve(options, onReady);
  const withSecretContext = async <T>(database: string | undefined, work: (context: SecretCliContext) => Promise<T>): Promise<T> => {
    const configured = database
      ? loadConfig({ ...process.env, DUTYDECK_DATABASE_URL: database }).databaseUrl
      : readDaemonStatus(resolveDaemonDir())?.database ?? loadConfig(process.env).databaseUrl;
    const repositories = createRepositories(configured);
    try {
      const provider = new LocalFileSecretProvider(secretDirectoryForDatabase(configured), { createDirectory: true });
      return await work({ repositories, provider });
    } finally { repositories.close(); }
  };
  const program = createCliProgram(packageJson.version, {
    serve,
    setup: async options => {
      const result = await runSetup(options);
      // setup 自己负责全部输出（人读或 --json 单行），这里只把成败映射到退出码。
      if (!result.ok) process.exitCode = 1;
    },
    doctor: async options => {
      const report = await runDoctor(options);
      // 有任何一项 fail 才算体检失败；仅有警告仍然是 0。
      if (!report.ok) process.exitCode = 1;
    },
    autostartEnable: async () => {
      const ui = createCliUi();
      const result = await autostartEnable(autostartOptions());
      ui.status(result.changed ? 'done' : 'ok', result.changed ? '已注册开机自启' : '开机自启已是目标状态',
        result.state.unitPath);
      for (const notice of result.notices) ui.hint(notice);
    },
    autostartDisable: async () => {
      const ui = createCliUi();
      const result = await autostartDisable(autostartOptions());
      ui.status(result.changed ? 'done' : 'ok', result.changed ? '已移除开机自启' : '开机自启本来就未启用');
      for (const notice of result.notices) ui.hint(notice);
    },
    autostartStatus: async options => {
      const result = await autostartStatus(autostartOptions());
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
        return;
      }
      const ui = createCliUi();
      if (!result.state.supported) {
        ui.status('info', '当前平台不支持开机自启', result.state.platform);
      } else {
        ui.status(result.state.enabled ? 'ok' : 'info', result.state.enabled ? '开机自启已启用' : '开机自启未启用',
          result.state.unitPath);
        // running 为 undefined 表示「无法确定」，不能当成「没在跑」——状态不能撒谎。
        if (result.state.running !== undefined) {
          ui.status(result.state.running ? 'ok' : 'info', result.state.running ? '服务已加载' : '服务当前未加载');
        }
        if (result.state.stale === true) {
          ui.status('warn', '开机项内容与当前启动路径不一致');
          ui.hint('重新注册以修复（nvm 切换或 npm 升级后会发生）：');
          ui.command('dutydeck autostart enable');
        }
      }
      for (const notice of result.notices) ui.hint(notice);
    },
    daemonStart: async options => {
      const result = await daemonStart(options, { serve: daemonServe });
      renderDaemonResult(result, options.json === true);
      // 起不来必须是非零退出码：脚本里 `dutydeck start && curl ...` 才不会踩空。
      // 「已经在运行」不算失败：目标状态已达成。
      if (!result.ok && result.state !== 'already-running') process.exitCode = 1;
    },
    daemonStop: async options => {
      const result = await daemonStop();
      renderDaemonResult(result, options.json === true);
      if (!result.ok) process.exitCode = 1;
    },
    daemonRestart: async options => {
      const result = await daemonRestart(options, { serve: daemonServe });
      renderDaemonResult(result, options.json === true);
      if (!result.ok) process.exitCode = 1;
    },
    daemonStatus: options => {
      const status = daemonStatus();
      renderDaemonResult({ action: 'status', ...status }, options.json === true);
      // status 是查询命令：不在运行不是「命令失败」，退出码保持 0。
    },
    update: async options => {
      output(await updateDutydeck(packageJson.version, options, {
        packageName: packageJson.name,
        runNpm: runNpmForDutydeckUpdate,
        restart: restartWithInstalledCli
      }));
    },
    authToken: async options => {
      // 优先用运行中/上次 daemon 记录的数据库路径，保证查看/轮换的是同一个 token；
      // daemon 从未运行过时回退到 loadConfig 的默认解析（<cwd>/.dutydeck/dutydeck.db）。
      const databaseUrl = readDaemonStatus(resolveDaemonDir())?.database ?? loadConfig(process.env).databaseUrl;
      const repos = createRepositories(databaseUrl);
      try {
        output(await runAuthTokenCommand(repos.config, { rotate: options.rotate === true }));
      } finally {
        repos.close();
      }
    },
    botmuxDiscover: runBotmuxDiscover,
    botmuxPlan: runBotmuxPlan,
    botmuxArchive: runBotmuxArchive,
    secretList: async options => { output(await withSecretContext(options.database, runSecretList)); },
    secretSet: async (id, options) => { output(await withSecretContext(options.database, context => runSecretSet(id, options, context))); },
    secretRotate: async (id, options) => { output(await withSecretContext(options.database, context => runSecretRotate(id, options, context))); },
    secretRemove: async (id, options) => { output(await withSecretContext(options.database, context => runSecretRemove(id, options, context))); },
    larkSend: async (markdown, options) => { output(await runLarkSend(markdown, options)); },
    larkUpdate: async (markdown, options) => { output(await runLarkUpdate(markdown, options)); },
    identityPreflight: async (channelBotId, options) => {
      const result = await runIdentityPreflightCli(channelBotId, options);
      output(result);
      if (result.status === 'blocked') process.exitCode = 2;
    },
    work: async (operation, args, options) => { output(await runWorkCommand(operation, args, options)); },
    groupSelf: async () => { output(await runGroupSelf()); },
    groupPeers: async () => { output(await runGroupPeers()); },
    groupMembers: async () => { output(await runGroupMembers()); },
    groupBots: async () => { output(await runGroupBots()); },
    groupMessages: async options => { output(await runGroupMessages(options)); },
    groupMessage: async messageId => { output(await runGroupMessage(messageId)); },
    groupSend: async (content, options) => { output(await runGroupSend(content, options)); },
    groupSendFile: async (path, options) => { output(await runGroupSendFile(path, options)); },
    groupWait: async options => { output(await runGroupWait(options)); },
    sessionSend: async text => { output(await runSessionSend(text)); },
    sessionAsk: async (question, options) => {
      // ask 有自己的 stdout/退出码契约（答案裸文本走 stdout，提示走 stderr），
      // 不能套用通用的 output()：调用方要能 `answer=$(dutydeck session ask ...)`。
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
  else if (error instanceof BotmuxImportError || error instanceof BotmuxImportCliError) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code, message: error.message } })}\n`);
  }
  else if (error instanceof SecretCliError || error instanceof SecretProviderError || error instanceof IdentityPreflightCliError) process.stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code, message: error.message } })}\n`);
  // setup 的三类错误自带中文说明和「该补哪个 flag」，直接原样呈现，不要压成 JSON 或堆栈。
  else if (error instanceof PromptUnavailableError || error instanceof PromptAbortedError || error instanceof InvalidWorkingDirectoryError) {
    process.stderr.write(`${error.message}\n`);
  }
  // autostart 明确拒绝不支持的平台/不可用的 systemd，并带上可执行的兜底建议。
  else if (error instanceof AutostartError) {
    process.stderr.write(`${error.message}\n`);
    for (const notice of error.notices) process.stderr.write(`  ${notice}\n`);
  }
  else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  // relay 的 CLI 错误自带退出码契约（2 用法 / 3 通道不可用），不能一律压成 1
  process.exit(error instanceof RelayCliError ? error.exitCode : 1);
}
