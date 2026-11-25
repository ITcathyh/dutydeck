// Configuration loading + validation for rovetap-jobs.
//
// Discovery order (see dd.notes):
//   1. --config <path>
//   2. $ROVETAP_JOBS_CONFIG
//   3. $DUTYDECK_PLUGIN_DATA/config.json   (real host-supervised location)
//   4. $HOME/.config/dutydeck/rovetap-jobs.json
//
// The host scrubs service env vars and never passes binding config/secrets to a
// service process, so secrets live in the deployer-written config.json (mode
// 0600) or in sibling *_file files. We never log or return those values.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';

export const DEFAULT_HANDLER_PATH = '/lark/events';
export const DEFAULT_LARK_BASE_URL = 'https://open.feishu.cn';

export async function discoverConfigPath(argv = process.argv.slice(2), env = process.env) {
  const flagIndex = argv.indexOf('--config');
  if (flagIndex !== -1 && argv[flagIndex + 1]) return resolve(argv[flagIndex + 1]);
  if (env.ROVETAP_JOBS_CONFIG) return resolve(env.ROVETAP_JOBS_CONFIG);
  if (env.DUTYDECK_PLUGIN_DATA) return join(env.DUTYDECK_PLUGIN_DATA, 'config.json');
  return join(homedir(), '.config', 'dutydeck', 'rovetap-jobs.json');
}

async function readSecretValue(value, file, configDir) {
  if (typeof value === 'string' && value.length) return value;
  if (typeof file === 'string' && file.length) {
    const path = isAbsolute(file) ? file : resolve(configDir, file);
    return (await readFile(path, 'utf8')).trim();
  }
  return '';
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

  const handlerToken = await readSecretValue(raw.handlerToken, raw.handlerTokenFile, configDir);
  const appId = str(raw.appId ?? raw.app_id);
  if (!handlerToken) throw new Error('配置缺少 handlerToken/handlerTokenFile（与 Dutydeck eventHandlers.token 相同的可信 bearer）');
  if (!appId) throw new Error('配置缺少 appId（外层机器人 app_id，例如 cli_xxx）');

  const appSecret = await readSecretValue(raw.appSecret, raw.appSecretFile, configDir);

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
    appSecret: await readSecretValue(lark.appSecret, lark.appSecretFile, configDir) || appSecret,
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

  const limitsRaw = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
  const limits = {
    maxInstructionChars: num(limitsRaw.maxInstructionChars, 4_000),
    maxMaterialChars: num(limitsRaw.maxMaterialChars, 20_000),
    threadScan: num(limitsRaw.threadScan, 30),
  };

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
