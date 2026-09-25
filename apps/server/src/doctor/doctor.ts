/**
 * `dutydeck doctor` —— 本机环境与配置体检。
 *
 * 四条硬约束（每条都对应一个真实踩坑）：
 *
 *   1. **只报不改。** 体检是诊断命令，不得因为「检查了一下」而改变磁盘状态：
 *      不建库、不建目录、不写配置、不生成令牌。因此本模块绝不调用
 *      createRepositories（会 mkdir + 建库 + 开 WAL + 可能 VACUUM 备份 + 跑迁移）、
 *      不调用 readLarkConfigs（会写回 lark.bots 做迁移）、不调用
 *      loadOrCreateAuthToken / rotateAuthToken（都会写）。唯一容许的副作用是
 *      只读打开 WAL 库时 SQLite 自建的 -wal/-shm 边车文件，见 probes.ts。
 *
 *   2. **状态不许说谎。** daemonStatus() 把死掉的 pid 折叠成 running:false，
 *      与「从未启动过」不可区分，所以额外读原始记录把两者分开。同理，端口探测
 *      有 'unknown' 第三态，探不出来就说探不出来，不冒充可用。
 *
 *   3. **绝不只报 FAILED。** 每个 fail/warn 都必须带 remedy，能给出可执行动作的
 *      还要带 command。测试逐项断言这个不变量。
 *
 *   4. **绝不泄密。** appSecret、access token 只判断存在性，值永不进入报告。
 *      测试用 JSON.stringify(report) 断言机密串不出现。
 *
 * 快：loadConfig 会 spawn 每个已知 Agent CLI 探版本（秒级），全流程只允许调用
 * 一次，结果由 config 与 agents 两项检查共享；端口探测带超时，绝不挂住。
 */
import { constants } from 'node:fs';
import { existsSync } from 'node:fs';
import { access as fsAccess, stat as fsStat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { loadConfig } from '@dutydeck/config';
import { daemonStatus } from '../daemon/command.js';
import { daemonPaths, readDaemonStatus, resolveDaemonDir } from '../daemon/daemon.js';
import { accessMode } from '../service.js';
import { createCliUi, type CliUi } from '../cli-ui.js';
import { defaultDatabaseProbe, defaultPortProbe } from './probes.js';
import {
  AUTH_TOKEN_CONFIG_KEY,
  DOCTOR_CONFIG_KEYS,
  DOCTOR_CONFIG_PREFIXES,
  checkAccessPosture,
  checkAccessToken,
  checkAgentAuth,
  checkAgents,
  checkAutostart,
  checkConfig,
  checkDaemon,
  checkDatabase,
  checkDutydeckDir,
  checkLark,
  checkLarkListener,
  checkLarkMemory,
  checkNodeVersion,
  checkPlatformPickers,
  checkPort,
  checkPostureDrift,
  checkSchema,
  larkBotsConfigKey,
  summarize,
  type DirectoryObservation
} from './checks.js';
import type {
  DatabaseProbeResult,
  DoctorAutostartResult,
  DoctorCheck,
  DoctorConfig,
  DoctorDependencies,
  DoctorOptions,
  DoctorReport
} from './types.js';

export type {
  CheckLevel,
  DatabaseProbe,
  DatabaseProbeResult,
  DoctorCheck,
  DoctorConfig,
  DoctorDependencies,
  DoctorOptions,
  DoctorReport,
  PortProbe,
  PortProbeOutcome
} from './types.js';
export { REQUIRED_NODE_VERSION } from './checks.js';

const DEFAULT_PORT_PROBE_TIMEOUT_MS = 1_000;

/** 动态 import autostart 模块：它可能尚未落地，缺失时该项降级为 skip。 */
async function loadAutostartStatus(): Promise<DoctorAutostartResult | undefined> {
  try {
    const module = await import('../autostart/autostart.js');
    if (typeof module.autostartStatus !== 'function') return undefined;
    return await module.autostartStatus();
  } catch {
    // 模块不存在 / 抛错都不该让整个体检崩掉 —— 体检本身必须比被检对象更稳。
    return undefined;
  }
}

/**
 * 期望的 migration 头版本。
 *
 * `migrations` 目前并未从 @dutydeck/storage 的入口导出（实测 TS2305），所以这里
 * 动态探一次：拿到就比对，拿不到就让 schema 检查 skip，绝不拿猜的数字报「库过期」。
 */
async function resolveExpectedSchemaVersion(): Promise<number | undefined> {
  try {
    const module = await import('@dutydeck/storage') as { migrations?: ReadonlyArray<{ version: number }> };
    const head = module.migrations?.at(-1)?.version;
    return typeof head === 'number' ? head : undefined;
  } catch {
    return undefined;
  }
}

/** `.dutydeck/` 目录的存在性、可写性与权限位。任何一步失败都不抛，如实降级。 */
async function observeDirectory(
  path: string,
  platform: string,
  exists: (candidate: string) => boolean,
  access: (candidate: string, mode: number) => Promise<void>,
  stat: (candidate: string) => Promise<{ mode: number }>
): Promise<DirectoryObservation> {
  const posix = platform !== 'win32';
  if (!exists(path)) return { path, exists: false, writable: false, posix };
  let writable = true;
  let error: string | undefined;
  try {
    await access(path, constants.W_OK);
  } catch (accessError) {
    writable = false;
    error = accessError instanceof Error ? accessError.message : String(accessError);
  }
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode;
  } catch {
    mode = undefined;
  }
  return { path, exists: true, writable, posix, ...(mode === undefined ? {} : { mode }), ...(error ? { error } : {}) };
}

/** 人类可读渲染：每项一行，fail/warn 追加修法与命令。 */
function render(ui: CliUi, report: DoctorReport): void {
  ui.section('Dutydeck 环境体检');
  for (const check of report.checks) {
    ui.status(check.level, check.label, check.detail);
    if (check.remedy) ui.hint(check.remedy);
    if (check.command) ui.command(check.command);
    if (check.verify) ui.hint(`验证：${check.verify}`);
    if (check.link) ui.hint(check.link);
  }
  ui.section('体检结论');
  ui.keyValues([
    ['通过', String(report.summary.ok)],
    ['警告', String(report.summary.warn)],
    ['失败', String(report.summary.fail)],
    ['跳过', String(report.summary.skip)]
  ]);
  const actionable = report.checks.filter(check => (check.level === 'fail' || check.level === 'warn') && check.command);
  if (actionable.length > 0) {
    ui.summary('接下来做什么', actionable.map(check => ({ text: `${check.label}：${check.remedy ?? ''}`.trim(), ...(check.command ? { command: check.command } : {}) })));
  } else {
    ui.line();
    ui.status(report.ok ? 'ok' : 'fail', report.next);
  }
}

export async function runDoctor(
  options: DoctorOptions = {},
  dependencies: DoctorDependencies = {}
): Promise<DoctorReport> {
  const env = dependencies.env ?? process.env;
  const json = options.json === true;
  const ui = dependencies.ui ?? createCliUi({ env });
  const platform = dependencies.platform ?? process.platform;
  const nodeVersion = dependencies.nodeVersion ?? process.version;
  const exists = dependencies.exists ?? existsSync;
  const access = dependencies.access ?? fsAccess;
  const stat = dependencies.stat ?? (async (path: string) => ({ mode: (await fsStat(path)).mode }));
  const databaseProbe = dependencies.databaseProbe ?? defaultDatabaseProbe;
  const portProbe = dependencies.portProbe ?? defaultPortProbe;
  const portTimeout = dependencies.portProbeTimeoutMs ?? DEFAULT_PORT_PROBE_TIMEOUT_MS;
  const username = dependencies.username ?? (() => {
    try { return userInfo().username; } catch { return env.USER ?? 'your-user'; }
  })();

  // 进度走 stderr，结果走 stdout —— `dutydeck doctor | head -1` 才有意义。
  const progress = (text: string) => { if (!json) ui.progress(text); };

  const checks: DoctorCheck[] = [];

  // ---- 1. Node 版本 ----
  checks.push(checkNodeVersion(nodeVersion));

  // ---- 2. 守护进程 ----
  progress('检查守护进程状态');
  const status = dependencies.daemonStatus
    ? dependencies.daemonStatus()
    : daemonStatus();
  const record = dependencies.daemonRecord
    ? dependencies.daemonRecord()
    : readDaemonStatus(resolveDaemonDir());
  const logFile = dependencies.daemonLogFile
    ?? (dependencies.daemonRecord ? undefined : daemonPaths(resolveDaemonDir()).logFile);
  checks.push(checkDaemon({ status, ...(record ? { record } : {}), ...(logFile ? { logFile } : {}) }));

  // ---- 3. 配置解析（loadConfig 只允许调用一次） ----
  progress('解析配置（首次会探测各 Agent CLI 版本，可能需要几秒）');
  const config: DoctorConfig = dependencies.config ?? loadConfig(env);
  checks.push(checkConfig(config));

  // ---- 4. 数据库 + 迁移 ----
  // 库路径以守护进程记录为准，与 cli.ts 的取法一致（它才是真正在用的那个库）。
  const databaseUrl = record?.database ?? config.databaseUrl;
  progress(`只读探测数据库 ${databaseUrl}`);
  const probe: DatabaseProbeResult = await databaseProbe(databaseUrl, DOCTOR_CONFIG_KEYS, DOCTOR_CONFIG_PREFIXES);
  checks.push(checkDatabase(databaseUrl, probe));
  const expectedSchemaVersion = dependencies.expectedSchemaVersion ?? await resolveExpectedSchemaVersion();
  checks.push(checkSchema(probe, expectedSchemaVersion));

  // ---- 5. .dutydeck 目录 ----
  const dutydeckDir = dirname(databaseUrl);
  checks.push(checkDutydeckDir(await observeDirectory(dutydeckDir, platform, exists, access, stat)));

  // ---- 6. Agent ----
  checks.push(checkAgents(config.agents));
  checks.push(checkAgentAuth(config.agents));

  // ---- 7. 飞书 ----
  const databaseUnreadable = !probe.exists || Boolean(probe.error);
  const listenerDisabled = env.DUTYDECK_DISABLE_LARK_LISTENER === 'true';
  const lark = checkLark(
    databaseUnreadable ? { unavailable: true } : { ...(probe.values?.[larkBotsConfigKey] ? { raw: probe.values[larkBotsConfigKey] } : {}) },
    listenerDisabled
  );
  checks.push(...lark.checks);
  checks.push(checkLarkListener(lark.botCount, status.running, listenerDisabled));
  checks.push(checkLarkMemory(
    databaseUnreadable ? { unavailable: true } : { ...(probe.values?.[larkBotsConfigKey] ? { raw: probe.values[larkBotsConfigKey] } : {}), ...(probe.values ? { values: probe.values } : {}) },
    new Date()
  ));

  // ---- 8. 访问姿态 ----
  const mode = accessMode({ host: config.host, authEnabled: config.authEnabled });
  const posture = {
    mode,
    host: config.host,
    port: config.port,
    authEnabled: config.authEnabled,
    // 只有进程真的在跑时，落盘记录里的 host/port/auth 才代表「现在的行为」。
    ...(status.running && record?.host !== undefined ? { runningHost: record.host } : {}),
    ...(status.running && record?.port !== undefined ? { runningPort: record.port } : {}),
    ...(status.running && record?.authEnabled !== undefined ? { runningAuthEnabled: record.authEnabled } : {})
  };
  checks.push(checkAccessPosture(posture));
  const drift = checkPostureDrift(posture);
  if (drift) checks.push(drift);
  checks.push(checkAccessToken({
    mode,
    present: Boolean(probe.values?.[AUTH_TOKEN_CONFIG_KEY]?.trim()),
    ...(databaseUnreadable ? { unknown: true } : {})
  }));

  // ---- 9. 端口 ----
  // 端口以守护进程记录为准，和上面数据库路径的取法一致：正在跑的那个端口才是
  // 用户此刻真正在用的。若只探配置端口，用 `--port` 起的实例会把「配置里那个
  // 没人用的端口」当成冲突报 fail，并给出换端口的错误建议——漂移本身已由
  // access.drift 单独报出，这里不该重复成一条假故障。
  const runningPort = status.running && record?.port !== undefined ? record.port : undefined;
  const probeHost = (status.running && record?.host !== undefined ? record.host : undefined) ?? config.host;
  const probePort = runningPort ?? config.port;
  progress(`探测端口 ${probePort}`);
  const outcome = await portProbe(probeHost, probePort, portTimeout);
  // 占用者是不是我们自己：进程在跑 + 记录的端口就是这个端口。
  const ownDaemon = status.running && (record?.port === probePort || status.address?.includes(`:${probePort}`) === true);
  checks.push(checkPort({ host: probeHost, port: probePort, outcome, ownDaemon }, platform));

  // ---- 10. 平台能力 ----
  checks.push(checkPlatformPickers(platform));

  // ---- 11. 开机自启 ----
  progress('检查开机自启');
  const autostart = dependencies.autostartStatus
    ? await dependencies.autostartStatus().catch(() => undefined)
    : await loadAutostartStatus();
  checks.push(...checkAutostart(autostart, username));

  const summary = summarize(checks);
  // ok 有且仅有「不存在 fail」时为 true —— 仅有警告仍然算通过。
  const ok = summary.fail === 0;
  const firstFailure = checks.find(check => check.level === 'fail');
  const firstActionable = firstFailure ?? checks.find(check => check.level === 'warn' && check.command);
  const next = firstFailure?.command
    ?? firstFailure?.remedy
    ?? (summary.fail > 0
      ? '存在失败项，请按上面的补救说明处理。'
      : firstActionable?.command
        ?? (summary.warn > 0 ? '没有失败项，但有警告值得处理。' : '一切正常，可以直接使用 Dutydeck。'));

  const report: DoctorReport = { ok, action: 'doctor', checks, summary, next };

  if (json) {
    // --json 是行为契约：单行 JSON、无颜色、独占 stdout，不掺任何人类可读输出。
    ui.json(report);
  } else {
    render(ui, report);
  }
  return report;
}
