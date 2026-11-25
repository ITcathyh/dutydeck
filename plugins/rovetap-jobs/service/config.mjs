// Configuration loading + validation for rovetap-jobs.
//
// Discovery order:
//   1. --config <path>
//   2. $ROVETAP_JOBS_CONFIG
//   3. $DUTYDECK_PLUGIN_DATA/config.json   (real host-supervised location)
//   4. $HOME/.config/dutydeck/rovetap-jobs.json
//
// The host scrubs service env vars and never passes binding config/secrets to a
// service process, so secrets live in the deployer-written config.json (mode
// 0600) or in sibling *_file files. We never log or return those values.

import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { ROVE_ENTRY_CODEPOINTS } from './materials.mjs';

export const DEFAULT_HANDLER_PATH = '/lark/events';
export const DEFAULT_LARK_BASE_URL = 'https://open.feishu.cn';

/**
 * The receiver only ever binds a local loopback interface: it accepts
 * authenticated commander commands and never needs a network-reachable port.
 * Keep this allowlist narrow; deployers reach it from the same machine (or an
 * SSH tunnel), and eventHandlers URLs must point at 127.0.0.1.
 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1') return true;
  // The whole 127.0.0.0/8 block is loopback.
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return Boolean(m);
}

export async function discoverConfigPath(argv = process.argv.slice(2), env = process.env) {
  const flagIndex = argv.indexOf('--config');
  if (flagIndex !== -1 && argv[flagIndex + 1]) return resolve(argv[flagIndex + 1]);
  if (env.ROVETAP_JOBS_CONFIG) return resolve(env.ROVETAP_JOBS_CONFIG);
  if (env.DUTYDECK_PLUGIN_DATA) return join(env.DUTYDECK_PLUGIN_DATA, 'config.json');
  return join(homedir(), '.config', 'dutydeck', 'rovetap-jobs.json');
}

async function readSecretValue(value, file, configDir, label) {
  if (typeof value === 'string' && value.length) return value;
  if (typeof file === 'string' && file.length) {
    const path = isAbsolute(file) ? file : resolve(configDir, file);
    try {
      return (await readFile(path, 'utf8')).trim();
    } catch (error) {
      throw new Error(`${label} 指向的文件无法读取：${path}（${error?.code ?? error?.message ?? 'read error'}）；请检查路径与 0600 权限`);
    }
  }
  return '';
}

/** Fail at startup with a config-key-locatable message when a required path is unusable. */
async function assertUsablePath(path, mode, label, hint) {
  try {
    await access(path, mode);
  } catch (error) {
    throw new Error(`${label} 配置的路径不可用：${path}（${error?.code ?? error?.message ?? 'access error'}）；${hint}`);
  }
}

/**
 * Parse, fill defaults and resolve *_file secrets. Throws with an operator
 * facing (non-secret) message when a required field is missing/invalid.
 */
export async function loadConfig(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`配置文件不是 JSON 对象：${path}`);
  const configDir = resolve(path, '..');

  const dataDir = raw.dataDir
    ? (isAbsolute(raw.dataDir) ? raw.dataDir : resolve(configDir, raw.dataDir))
    : (process.env.DUTYDECK_PLUGIN_DATA || configDir);

  const handlerToken = await readSecretValue(raw.handlerToken, raw.handlerTokenFile, configDir, 'handlerTokenFile');
  const appId = str(raw.appId ?? raw.app_id);
  if (!handlerToken) throw new Error('配置缺少 handlerToken/handlerTokenFile（与 Dutydeck eventHandlers.token 相同的可信 bearer）');
  if (!appId) throw new Error('配置缺少 appId（外层机器人 app_id，例如 cli_xxx）');

  const appSecret = await readSecretValue(raw.appSecret, raw.appSecretFile, configDir, 'appSecretFile');

  const pairfobBin = str(raw.pairfobBin);
  if (pairfobBin && !isAbsolute(pairfobBin)) throw new Error('pairfobBin 必须是绝对路径（参数数组调用，不经 shell）');

  const pf = raw.pairfob && typeof raw.pairfob === 'object' ? raw.pairfob : {};
  const pairfob = {
    bin: str(pf.bin ?? raw.pairfobBin),
    project: str(pf.project ?? raw.projectAlias ?? 'rovetap') || 'rovetap',
    socket: str(pf.socket ?? process.env.ROVETAP_PROJECT_SOCKET),
    tokenFile: str(pf.tokenFile ?? process.env.ROVETAP_PROJECT_TOKEN_FILE),
    timeoutMs: num(pf.timeoutMs, 20_000),
  };
  if (pairfob.bin && !isAbsolute(pairfob.bin)) throw new Error('pairfob.bin 必须是绝对路径');

  const lark = raw.lark && typeof raw.lark === 'object' ? raw.lark : {};
  const larkConfig = {
    appId: str(lark.appId ?? appId),
    appSecret: await readSecretValue(lark.appSecret, lark.appSecretFile, configDir, 'lark.appSecretFile') || appSecret,
    baseUrl: str(lark.baseUrl ?? raw.larkBaseUrl ?? process.env.LARK_OPEN_API_BASE_URL ?? DEFAULT_LARK_BASE_URL).replace(/\/+$/, ''),
    timeoutMs: num(lark.timeoutMs, 8_000),
  };

  const replyRaw = raw.reply && typeof raw.reply === 'object' ? raw.reply : {};
  const reply = {
    // 'lark-api' (equivalent platform API, durable uuid) or 'dutydeck-cli' (the named supported CLI).
    mode: str(replyRaw.mode ?? raw.replyMode ?? 'lark-api'),
    dutydeckBin: str(replyRaw.dutydeckBin ?? raw.dutydeckBin ?? 'dutydeck'),
    database: str(replyRaw.database ?? raw.database),
    app: str(replyRaw.app ?? appId),
    timeoutMs: num(replyRaw.timeoutMs, 20_000),
  };
  if (!['lark-api', 'dutydeck-cli'].includes(reply.mode)) throw new Error("reply.mode 只能是 'lark-api' 或 'dutydeck-cli'");
  if (reply.mode === 'dutydeck-cli' && reply.dutydeckBin.includes('/') && !isAbsolute(reply.dutydeckBin)) {
    throw new Error('reply.dutydeckBin 含路径时必须是绝对路径');
  }

  const listenRaw = raw.listen && typeof raw.listen === 'object' ? raw.listen : {};
  const listen = {
    host: str(listenRaw.host ?? '127.0.0.1') || '127.0.0.1',
    port: Number.isInteger(listenRaw.port) ? listenRaw.port : 0,
    path: str(listenRaw.path ?? DEFAULT_HANDLER_PATH) || DEFAULT_HANDLER_PATH,
  };
  if (!listen.path.startsWith('/')) listen.path = `/${listen.path}`;
  if (!isLoopbackHost(listen.host)) {
    throw new Error(
      `listen.host=${JSON.stringify(listen.host)} 不是本机回环地址：本服务只允许监听 127.0.0.1（或 ::1/localhost），`
      + '不能绑定 0.0.0.0 或局域网地址；eventHandlers URL 也必须是 http://127.0.0.1:<port>/...',
    );
  }

  const limitsRaw = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
  const limits = {
    // Both instruction and material entries share the upstream 4000 Unicode
    // code point contract; configuration may only lower the cap.
    maxInstructionChars: cappedNum(limitsRaw.maxInstructionChars, ROVE_ENTRY_CODEPOINTS, ROVE_ENTRY_CODEPOINTS),
    maxMaterialChars: cappedNum(limitsRaw.maxMaterialChars, ROVE_ENTRY_CODEPOINTS, ROVE_ENTRY_CODEPOINTS),
    threadScan: num(limitsRaw.threadScan, 30),
  };

  // Required integrations. Refusing to start with a config-key-locatable
  // message (printed by main.mjs as `failed to start: ...`) is better than
  // acknowledging /job commands that can never read material or create a job
  // and then going quiet in the topic.
  if (!pairfob.bin) {
    throw new Error('配置缺少 pairfob.bin（pairfob 可执行文件的绝对路径，例如 /usr/local/bin/pairfob）');
  }
  if (!pairfob.tokenFile) {
    throw new Error('配置缺少 pairfob.tokenFile（hub project-job enable 输出的项目令牌文件，通常为 <state-dir>/project-jobs/<project>.token）；也可设置环境变量 ROVETAP_PROJECT_TOKEN_FILE');
  }
  if (!larkConfig.appSecret) {
    throw new Error('配置缺少 appSecret/appSecretFile（或 lark.appSecret/lark.appSecretFile）：回读核对材料与默认回执都需要机器人应用 secret');
  }
  await assertUsablePath(pairfob.bin, constants.X_OK, 'pairfob.bin', '请确认 pairfob 已安装，且运行本服务的用户有执行权限');
  try {
    const projectToken = await readFile(pairfob.tokenFile, 'utf8');
    if (!projectToken.trim()) throw new Error('token file is empty');
  } catch (error) {
    throw new Error(
      `pairfob.tokenFile 指向的项目令牌缺失或不可读：${pairfob.tokenFile}`
      + `（${error?.message === 'token file is empty' ? '文件为空' : (error?.code ?? error?.message ?? 'read error')}）；`
      + '请对照 hub project-job enable 输出并确认文件 0600、属主为运行 Dutydeck 的用户',
    );
  }

  return {
    configPath: path,
    dataDir,
    appId,
    // Trusted bot open_id used to authenticate event mentions: only a mention
    // whose id.open_id equals this is stripped before /job parsing. Leave
    // empty to accept bare `/job` only; @-prefixed messages then continue.
    selfOpenId: str(raw.selfOpenId ?? raw.botOpenId),
    handlerToken,
    allowedChatIds: new Set(arr(raw.allowedChatIds ?? raw.dispatchChatIds)),
    commanderOpenIds: new Set(arr(raw.commanderOpenIds ?? raw.allowedOpenIds)),
    projectAliases: new Set(['rovetap', ...arr(raw.projectAliases)].map((x) => x.toLowerCase())),
    webBaseUrl: str(raw.webBaseUrl).replace(/\/+$/, ''),
    listen,
    lark: larkConfig,
    reply,
    pairfob,
    limits,
    pollMs: num(raw.pollMs, 1_000),
    phasePollMs: num(raw.phasePollMs, 5_000),
    retryBaseMs: num(raw.retryBaseMs, 500),
    httpMaxBodyBytes: num(raw.httpMaxBodyBytes, 1_048_576),
  };
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function arr(value) {
  return Array.isArray(value) ? value.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
}
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
/** Positive number with an upstream ceiling: the operator can only lower it. */
function cappedNum(value, fallback, ceiling) {
  return Math.min(num(value, fallback), ceiling);
}
