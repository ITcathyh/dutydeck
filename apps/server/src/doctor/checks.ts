/**
 * 逐项检查的纯逻辑。
 *
 * 每个 check* 函数只接受已经取好的观测值，返回 DoctorCheck，不自己碰系统。
 * 这样 doctor.ts 负责「取数 + 编排 + 渲染」，本文件负责「判定 + 给修法」，
 * 测试可以直接喂观测值断言分级。
 *
 * 全局不变量（doctor.test.ts 逐项断言）：
 *   · 每个 fail / warn 必须带 remedy，有可执行动作时必须带 command。
 *   · 任何字段都不得包含机密（app secret、access token）。
 */
import { larkBotsConfigKey, larkExecutionConfirmed, publicLarkConfigs, type StoredLarkConfig } from '../lark/config.js';
import { AUTH_TOKEN_CONFIG_KEY } from '../auth/auth.js';
import { larkMemoryErrorLabel } from '../lark/memory.js';
import { larkMemoryPipelineRules } from '../lark/memory-pipeline.js';
import type {
  CheckLevel,
  DatabaseProbeResult,
  DoctorAutostartResult,
  DoctorCheck,
  DoctorConfig,
  DoctorDaemonRecord,
  DoctorDaemonStatus,
  PortProbeOutcome
} from './types.js';

/** workspace 根 package.json 的 engines.node。 */
export const REQUIRED_NODE_VERSION = '22.12.0';

export { larkBotsConfigKey, AUTH_TOKEN_CONFIG_KEY };

/** 体检需要从 configs 表读的键。都是「读」，绝不写。 */
export const DOCTOR_CONFIG_KEYS = [larkBotsConfigKey, AUTH_TOKEN_CONFIG_KEY] as const;

/** 会话记忆状态的键前缀，与 lark/memory.ts 的 larkMemoryStateKey 一致：`lark.memory.state.<appId>.<pool>`。 */
const larkMemoryStatePrefix = 'lark.memory.state.';

/** 体检按前缀读的键：会话记忆状态按「机器人 + 记忆池」分键，事先不知道有哪些池。 */
export const DOCTOR_CONFIG_PREFIXES = [larkMemoryStatePrefix] as const;

// ─── 1. node.version ─────────────────────────────────────────────────────────

/** 'v22.12.0' → [22,12,0]；缺段按 0 补，非数字段按 0（noUncheckedIndexedAccess 友好）。 */
export function parseVersion(raw: string): [number, number, number] {
  const parts = raw.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function checkNodeVersion(nodeVersion: string): DoctorCheck {
  const satisfied = compareVersions(nodeVersion, REQUIRED_NODE_VERSION) >= 0;
  if (satisfied) {
    return { id: 'node.version', label: 'Node.js 版本', level: 'ok', detail: nodeVersion };
  }
  return {
    id: 'node.version',
    label: 'Node.js 版本',
    level: 'fail',
    detail: `当前 ${nodeVersion}，需要 >= v${REQUIRED_NODE_VERSION}`,
    remedy: `Dutydeck 要求 Node.js >= ${REQUIRED_NODE_VERSION}。请升级 Node 后重跑，例如用 nvm 装一个满足要求的版本。`,
    command: `nvm install ${REQUIRED_NODE_VERSION}`,
    verify: 'node --version'
  };
}

// ─── 2. daemon.status ────────────────────────────────────────────────────────

export interface DaemonObservation {
  status: DoctorDaemonStatus;
  /** 原始落盘记录；用于识别「记录存在但进程已死」。 */
  record?: DoctorDaemonRecord;
  logFile?: string;
}

/**
 * 守护进程状态。
 *
 * 状态不许说谎：daemonStatus() 已经把死掉的 pid 折叠成 running:false，这与
 * 「从未启动过」在返回值上完全一样。所以额外读原始记录，把「崩过」与「没起过」
 * 分成两种不同的输出 —— 前者要引导用户去看日志，后者只是还没开始。
 */
export function checkDaemon(observation: DaemonObservation): DoctorCheck {
  const { status, record } = observation;
  const logFile = status.logFile ?? observation.logFile;
  const recordedPid = record?.pid;

  if (status.running) {
    const detail = [status.address, recordedPid ? `pid ${recordedPid}` : status.pid ? `pid ${status.pid}` : undefined]
      .filter(Boolean).join(' · ');
    if (status.ready === false) {
      return {
        id: 'daemon.status',
        label: '守护进程',
        level: 'warn',
        detail: `进程在跑但尚未就绪${detail ? `（${detail}）` : ''}`,
        remedy: '守护进程已启动但还没报告 ready：可能仍在初始化，也可能卡在启动过程中。稍等几秒重跑体检；若一直如此，看日志再重启。',
        command: 'dutydeck restart',
        ...(logFile ? { verify: `tail -n 50 ${logFile}` } : {})
      };
    }
    return { id: 'daemon.status', label: '守护进程', level: 'ok', detail: detail || '运行中' };
  }

  // 有记录、有 pid，但进程已经不在 —— 崩了或被杀了，绝不能和「没启动」混为一谈。
  if (recordedPid !== undefined && recordedPid > 0) {
    return {
      id: 'daemon.status',
      label: '守护进程',
      level: 'warn',
      detail: `记录中的 pid ${recordedPid} 已不存在（残留状态，进程可能崩溃或被强杀）`,
      remedy: `上次记录的守护进程 pid ${recordedPid} 已经消失，这是残留状态而非从未启动。${logFile ? `先看日志确认崩溃原因（${logFile}），再重新启动。` : '重新启动即可清理残留状态。'}`,
      command: 'dutydeck start',
      ...(logFile ? { verify: `tail -n 50 ${logFile}` } : {})
    };
  }

  return {
    id: 'daemon.status',
    label: '守护进程',
    level: 'warn',
    detail: '未运行',
    remedy: '本机没有正在运行的 Dutydeck 守护进程，Web 面板与飞书监听都不会工作。启动它即可。',
    command: 'dutydeck start',
    verify: 'dutydeck status'
  };
}

// ─── 3. config.resolved ──────────────────────────────────────────────────────

/**
 * 报告的是**配置解析结果**，不是运行中进程的实际行为——两者不一致时由
 * access.drift 单独指出。所以这里的库路径可能与「本地数据库」一项不同：
 * 后者以守护进程记录为准。加「配置」二字避免读者把两处当成互相矛盾。
 */
export function checkConfig(config: DoctorConfig): DoctorCheck {
  return {
    id: 'config.resolved',
    label: '配置解析',
    level: 'ok',
    detail: `${config.host}:${config.port} · 认证${config.authEnabled ? '开启' : '关闭'} · 配置库 ${config.databaseUrl}`
  };
}

// ─── 4. database.reachable / schema.migrations ───────────────────────────────

export function checkDatabase(path: string, probe: DatabaseProbeResult): DoctorCheck {
  if (!probe.exists) {
    // 刻意不建库：诊断命令建出一个空库，会让「还没初始化」变成「已初始化但没数据」。
    return {
      id: 'database.reachable',
      label: '本地数据库',
      level: 'warn',
      detail: `尚未初始化（${path} 不存在）`,
      remedy: '数据库会在首次启动守护进程时自动创建并迁移。体检不会替你建库，以免留下一个空库掩盖真实状态。',
      command: 'dutydeck start',
      verify: 'dutydeck status'
    };
  }
  if (probe.error) {
    return {
      id: 'database.reachable',
      label: '本地数据库',
      level: 'fail',
      detail: `无法读取：${probe.error}`,
      remedy: `打开 ${path} 失败。检查该文件的属主与权限：应属于当前用户，目录权限 700、库文件 600；若文件已损坏，停掉守护进程后从 .pre-v10.bak 之类的备份恢复。`,
      command: `ls -l ${path}`,
      verify: `sqlite3 ${path} 'PRAGMA integrity_check'`
    };
  }
  return { id: 'database.reachable', label: '本地数据库', level: 'ok', detail: path };
}

/**
 * 迁移漂移检查。
 *
 * expectedVersion 为 undefined 时降级 skip：`migrations` 目前并未从
 * @dutydeck/storage 的入口导出（实测 TS2305），拿不到期望头版本时如实说不知道，
 * 不要拿一个猜的数字去报「库过期」。
 */
export function checkSchema(probe: DatabaseProbeResult, expectedVersion?: number): DoctorCheck {
  if (!probe.exists || probe.error) {
    return { id: 'schema.migrations', label: '数据库迁移', level: 'skip', detail: '数据库不可读，跳过' };
  }
  if (expectedVersion === undefined) {
    return { id: 'schema.migrations', label: '数据库迁移', level: 'skip', detail: `已应用版本 ${probe.appliedVersion ?? 0}（期望版本未知，跳过比对）` };
  }
  const applied = probe.appliedVersion ?? 0;
  if (applied === expectedVersion) {
    return { id: 'schema.migrations', label: '数据库迁移', level: 'ok', detail: `版本 ${applied}` };
  }
  if (applied < expectedVersion) {
    return {
      id: 'schema.migrations',
      label: '数据库迁移',
      level: 'warn',
      detail: `已应用 ${applied}，当前代码期望 ${expectedVersion}`,
      remedy: '数据库结构比当前代码旧。迁移会在守护进程下次启动时自动补齐；重启一次即可。',
      command: 'dutydeck restart',
      verify: 'dutydeck doctor'
    };
  }
  return {
    id: 'schema.migrations',
    label: '数据库迁移',
    level: 'warn',
    detail: `已应用 ${applied}，高于当前代码期望的 ${expectedVersion}`,
    remedy: '数据库是更新版本的 Dutydeck 写下的，当前这份代码更旧，继续用可能读不懂新结构。请把 Dutydeck 升级到最新版本。',
    command: 'dutydeck update',
    verify: 'dutydeck --version'
  };
}

// ─── 5. dutydeck.dir ──────────────────────────────────────────────────────────

export interface DirectoryObservation {
  path: string;
  exists: boolean;
  writable: boolean;
  /** 无法取到（不存在 / 非 POSIX）时 undefined。 */
  mode?: number;
  posix: boolean;
  error?: string;
}

/** `.dutydeck/` 存放 access token 与飞书凭据，组/其他人可访问就是泄露面。 */
export function checkDutydeckDir(observation: DirectoryObservation): DoctorCheck {
  const { path, exists, writable, mode, posix } = observation;
  if (!exists) {
    return {
      id: 'dutydeck.dir',
      label: '.dutydeck 目录',
      level: 'warn',
      detail: `尚不存在：${path}`,
      remedy: '该目录会在首次启动时自动创建（权限 700）。它保存访问令牌与渠道凭据，不要手工放宽权限。',
      command: 'dutydeck start',
      verify: `ls -ld ${path}`
    };
  }
  if (!writable) {
    return {
      id: 'dutydeck.dir',
      label: '.dutydeck 目录',
      level: 'fail',
      detail: `不可写：${path}${observation.error ? `（${observation.error}）` : ''}`,
      remedy: `Dutydeck 需要写入 ${path}（数据库、令牌、日志都在这里）。把它的属主改回当前用户并收紧到 700。`,
      command: `chmod 700 ${path}`,
      verify: `ls -ld ${path}`
    };
  }
  // Windows 不用 POSIX mode 表达 ACL，chmod 在那里给不出等价保护，不做无意义的告警。
  if (posix && mode !== undefined && (mode & 0o077) !== 0) {
    const octal = (mode & 0o777).toString(8).padStart(3, '0');
    return {
      id: 'dutydeck.dir',
      label: '.dutydeck 目录',
      level: 'warn',
      detail: `权限过宽：${octal}（同组或其他用户可访问）`,
      remedy: `${path} 里保存着访问令牌与飞书应用凭据，当前权限 ${octal} 允许同组/其他用户读取。收紧为仅属主可访问。`,
      command: `chmod 700 ${path}`,
      verify: `ls -ld ${path}`
    };
  }
  const octal = mode === undefined ? undefined : (mode & 0o777).toString(8).padStart(3, '0');
  return { id: 'dutydeck.dir', label: '.dutydeck 目录', level: 'ok', detail: octal ? `${path}（${octal}）` : path };
}

// ─── 6. agents.detected / agents.auth ────────────────────────────────────────

export function checkAgents(agents: DoctorConfig['agents']): DoctorCheck {
  if (agents.length === 0) {
    return {
      id: 'agents.detected',
      label: 'Agent CLI',
      level: 'warn',
      detail: '未检测到任何已安装的 Agent CLI',
      remedy: 'Dutydeck 只驱动本机已安装的 Agent CLI。先安装其中任意一个（如 Claude Code、Codex、Gemini），再重跑配置向导让它被登记。',
      command: 'dutydeck setup',
      verify: 'dutydeck doctor'
    };
  }
  const listed = agents.map(agent => (agent.version ? `${agent.name} ${agent.version}` : agent.name)).join('、');
  return { id: 'agents.detected', label: 'Agent CLI', level: 'ok', detail: `${agents.length} 个：${listed}` };
}

/**
 * 认证状态刻意不猜。
 *
 * 各家 CLI 的登录态存放方式完全不同（keychain、~/.config 下的 json、环境变量），
 * 没有统一的判定方式；猜错会产生假告警，把本来能用的环境说成坏的，用户反而不敢用。
 * 所以只如实说明「这件事归各 CLI 自己管」并给出验证方式。
 */
export function checkAgentAuth(agents: DoctorConfig['agents']): DoctorCheck {
  // 刻意不用 agent.command 拼验证命令：ACPX 内置 agent 的 command 是 argv[0]，
  // 实际值往往是 `npx`，回显成「验证：npx」纯属误导。用名字点名让用户自己跑那个 CLI。
  const names = agents.map(agent => agent.name).join('、');
  return {
    id: 'agents.auth',
    label: 'Agent 认证',
    level: 'info',
    detail: names
      ? `Agent 的登录/认证由各 CLI 自己管理，Dutydeck 不代为判断；要确认登录态，直接在终端运行对应 CLI（${names}）`
      : 'Agent 的登录/认证由各 CLI 自己管理，Dutydeck 不代为判断；要确认登录态，直接在终端运行对应 CLI'
    // info 级不需要 remedy：这不是问题，只是说明责任边界。
  };
}

// ─── 7. lark.config / lark.listener ──────────────────────────────────────────

export interface LarkObservation {
  /** configs 表里 lark.bots 的原始值；undefined 表示未配置。 */
  raw?: string;
  /** 数据库不可读时为 true —— 与「确实没配」区分开。 */
  unavailable?: boolean;
}

export interface LarkCheckResult {
  checks: DoctorCheck[];
  /** 已解析出的机器人数量，供 listener 检查复用。 */
  botCount: number;
}

/**
 * 飞书配置检查。
 *
 * ⚠️ 刻意不调用 readLarkConfigs()：它在遇到需要迁移的旧记录时会**写回**
 * lark.bots，还会把 legacy 的 lark.credentials 迁移过去。体检读一下就改用户
 * 配置是不可接受的。这里自己 parse 原始值，再用纯函数 publicLarkConfigs 投影。
 *
 * appSecret 是明文存储的，全流程只判断「有没有」，绝不写进任何输出字段。
 */
export function checkLark(observation: LarkObservation, listenerDisabled: boolean): LarkCheckResult {
  if (observation.unavailable) {
    return {
      botCount: 0,
      checks: [{ id: 'lark.config', label: '飞书配置', level: 'skip', detail: '数据库不可读，无法读取飞书配置' }]
    };
  }
  if (!observation.raw) {
    return {
      botCount: 0,
      checks: [{ id: 'lark.config', label: '飞书配置', level: 'skip', detail: '未配置飞书' }]
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(observation.raw);
  } catch {
    return {
      botCount: 0,
      checks: [{
        id: 'lark.config',
        label: '飞书配置',
        level: 'fail',
        detail: `${larkBotsConfigKey} 不是合法 JSON，飞书机器人不会被加载`,
        remedy: `configs 表里的 ${larkBotsConfigKey} 已损坏。重新走一遍配置向导覆盖它；凭据请用 dutydeck secret set 录入，不会回显到终端。`,
        command: 'dutydeck setup --lark-app-id <应用ID>',
        verify: 'dutydeck doctor --json'
      }],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      botCount: 0,
      checks: [{
        id: 'lark.config',
        label: '飞书配置',
        level: 'fail',
        detail: `${larkBotsConfigKey} 不是数组，飞书机器人不会被加载`,
        remedy: `configs 表里的 ${larkBotsConfigKey} 结构异常（期望是数组）。重新走一遍配置向导覆盖它。`,
        command: 'dutydeck setup --lark-app-id <应用ID>',
        verify: 'dutydeck doctor --json'
      }],
    };
  }

  const entries = parsed as Array<Partial<StoredLarkConfig>>;
  const checks: DoctorCheck[] = [];

  // 缺 appId / appSecret 的条目：normalizeStoredConfig 会静默丢弃它们，
  // 用户看到的就是「配了但没生效」，必须显式报出来。
  const missingSecret = entries.filter(entry => entry.appId && !String(entry.appSecret ?? '').trim());
  const missingAppId = entries.filter(entry => !entry.appId);
  const usable = entries.filter((entry): entry is StoredLarkConfig =>
    Boolean(entry.appId) && Boolean(String(entry.appSecret ?? '').trim()));

  if (missingSecret.length > 0) {
    const ids = missingSecret.map(entry => entry.appId).filter(Boolean).join('、');
    checks.push({
      id: 'lark.config',
      label: '飞书配置',
      level: 'fail',
      // 只报「缺失」这一事实，永不打印 secret 本身。
      detail: `${missingSecret.length} 个机器人缺少 App Secret：${ids}`,
      remedy: `缺少 App Secret 的飞书机器人会被静默忽略。重新绑定以补齐凭据；也可以用 dutydeck secret set 录入，它从文件描述符读取、不会把凭据回显到终端或 shell 历史。`,
      command: `dutydeck setup --lark-app-id ${missingSecret[0]?.appId ?? '<应用ID>'}`,
      verify: 'dutydeck doctor --json'
    });
  } else if (missingAppId.length > 0) {
    checks.push({
      id: 'lark.config',
      label: '飞书配置',
      level: 'fail',
      detail: `${missingAppId.length} 个条目缺少 App ID，会被忽略`,
      remedy: '存在没有 App ID 的飞书配置条目，它们不会被加载。重新走配置向导覆盖这份配置。',
      command: 'dutydeck setup --lark-app-id <应用ID>',
      verify: 'dutydeck doctor --json'
    });
  } else {
    // publicLarkConfigs 是纯函数、同步、且本身就是「浏览器安全」的投影（不含 appSecret）。
    const view = publicLarkConfigs(usable, { listeningDisabled: listenerDisabled });
    const names = view.bots.map(bot => `${bot.name}（${bot.appId}）`).join('、');
    checks.push({
      id: 'lark.config',
      label: '飞书配置',
      level: 'ok',
      detail: `${view.bots.length} 个机器人：${names}（凭据齐备）`
    });

    const unconfirmed = view.bots.filter(bot => bot.listening && !larkExecutionConfirmed(bot));
    if (unconfirmed.length > 0) {
      checks.push({
        id: 'lark.full-trust',
        label: '飞书完全信任确认',
        level: 'warn',
        detail: `${unconfirmed.length} 个机器人已开启监听但未确认完全信任：${unconfirmed.map(bot => bot.appId).join('、')}`,
        remedy: '在 Web 面板中选择逐次询问模式，或在需要无人值守执行时确认完全信任。',
        command: `dutydeck setup --lark-app-id ${unconfirmed[0]?.appId ?? '<应用ID>'}`,
        verify: 'dutydeck doctor --json'
      });
    }
    const incomplete = view.bots.filter(bot => !bot.setupComplete);
    if (incomplete.length > 0) {
      checks.push({
        id: 'lark.setup-complete',
        label: '飞书配置完整度',
        level: 'warn',
        detail: `${incomplete.length} 个机器人尚未配完（缺默认 Agent 或执行模式未确认）：${incomplete.map(bot => bot.appId).join('、')}`,
        remedy: '补上默认 Agent，并选择逐次询问模式；如需无人值守执行，再确认完全信任。',
        command: `dutydeck setup --lark-app-id ${incomplete[0]?.appId ?? '<应用ID>'}`,
        verify: 'dutydeck doctor --json'
      });
    }
  }

  return { checks, botCount: usable.length };
}

export function checkLarkListener(botCount: number, daemonRunning: boolean, listenerDisabled: boolean): DoctorCheck {
  if (listenerDisabled) {
    return {
      id: 'lark.listener',
      label: '飞书监听',
      level: 'warn',
      detail: '本进程环境里 DUTYDECK_DISABLE_LARK_LISTENER=true，监听已关闭',
      remedy: '环境变量 DUTYDECK_DISABLE_LARK_LISTENER=true 会让本进程完全不建立飞书长连接（等价于 --no-lark-listen）。要恢复监听，去掉该变量后重启守护进程。',
      command: 'unset DUTYDECK_DISABLE_LARK_LISTENER && dutydeck restart',
      verify: 'dutydeck doctor --json'
    };
  }
  if (botCount === 0) {
    return { id: 'lark.listener', label: '飞书监听', level: 'skip', detail: '未配置飞书，无需监听' };
  }
  if (!daemonRunning) {
    return {
      id: 'lark.listener',
      label: '飞书监听',
      level: 'warn',
      detail: '已配置飞书，但守护进程未运行，监听不可能是活的',
      remedy: '飞书长连接由守护进程持有。进程没跑起来时，机器人收不到任何消息。启动守护进程后监听才会建立。',
      command: 'dutydeck start',
      verify: 'dutydeck status'
    };
  }
  return { id: 'lark.listener', label: '飞书监听', level: 'ok', detail: `守护进程在运行，${botCount} 个机器人的监听由它持有` };
}

// ─── 7b. lark.memory ─────────────────────────────────────────────────────────

export interface LarkMemoryObservation {
  /** configs 表里 lark.bots 的原始值；undefined 表示未配置。 */
  raw?: string;
  /** 探针读到的键值，含 `lark.memory.state.*` 前缀键。 */
  values?: Readonly<Record<string, string | undefined>>;
  /** 数据库不可读时为 true。 */
  unavailable?: boolean;
}

/** 体检只关心的状态字段；其余字段（发送人、消息编号等）一律不读，自然也不会进报告。 */
interface MemoryPoolState {
  pendingTurns?: Array<{ senderKind?: unknown } | null>;
  lastExtractionAt?: unknown;
  running?: { startedAt?: unknown } | null;
  lastRun?: { ok?: unknown; error?: unknown } | null;
  migratedTo?: unknown;
}

const memoryTime = (value: unknown) => typeof value === 'string' && value ? value.slice(0, 16).replace('T', ' ') : '尚未提取';

/**
 * 会话记忆后台提取是否停摆：已完成、应该提取的轮次攒够一次提取的量，却既没有提取成功、
 * 也没有明确的跳过原因时标黄。
 *
 * 明确的跳过原因不算停摆：机器人发起的轮次本来就不作为记忆来源；关闭了自动提取的机器人
 * 只在 /memory consolidate 时提取；提取正在进行（未超过陈旧阈值）说明管线还活着。
 *
 * 只 parse 原始 JSON，不经 LarkMemoryStore：它的读路径会顺手把旧的按群账本迁移进群池（写库）。
 */
export function checkLarkMemory(observation: LarkMemoryObservation, now: Date): DoctorCheck {
  const base = { id: 'lark.memory', label: '飞书会话记忆提取' } as const;
  if (observation.unavailable) return { ...base, level: 'skip', detail: '数据库不可读，无法读取会话记忆状态' };
  if (!observation.raw) return { ...base, level: 'skip', detail: '未配置飞书' };
  let parsed: unknown;
  try { parsed = JSON.parse(observation.raw); } catch { parsed = undefined; }
  // lark.bots 坏掉由 lark.config 报 fail，这里不重复报。
  const bots = (Array.isArray(parsed) ? parsed : []) as Array<Partial<StoredLarkConfig> | null>;
  const enabled = bots.filter((bot): bot is Partial<StoredLarkConfig> & { appId: string } =>
    Boolean(bot && typeof bot.appId === 'string' && bot.appId && bot.memoryEnabled !== false));
  if (!enabled.length) return { ...base, level: 'skip', detail: '没有开启会话记忆的飞书机器人' };

  const stalled: string[] = [];
  const observed: string[] = [];
  const keys = Object.keys(observation.values ?? {}).sort();
  for (const bot of enabled) {
    const prefix = `${larkMemoryStatePrefix}${bot.appId}.`;
    const name = `${bot.name?.trim() || bot.displayName?.trim() || '机器人'}（${bot.appId}）`;
    for (const key of keys) {
      const raw = observation.values?.[key];
      if (!key.startsWith(prefix) || !raw) continue;
      let state: MemoryPoolState;
      try { state = JSON.parse(raw) as MemoryPoolState; } catch { continue; }
      // 已并入群池的旧按群状态只剩迁移占位，不再代表任何池。
      if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.migratedTo === 'string') continue;
      const pool = key.slice(prefix.length);
      const where = `${name}${pool === 'groups' ? '群共享池' : `聊天 ${pool}`}`;
      const human = (Array.isArray(state.pendingTurns) ? state.pendingTurns : []).filter(turn => turn?.senderKind !== 'bot').length;
      const startedAt = typeof state.running?.startedAt === 'string' ? Date.parse(state.running.startedAt) : Number.NaN;
      const running = Number.isFinite(startedAt) && now.getTime() - startedAt < larkMemoryPipelineRules.staleRunningMs;
      const manual = bot.memoryAutoExtract === false;
      const lastSuccess = memoryTime(state.lastExtractionAt);
      if (!manual && !running && human >= larkMemoryPipelineRules.extractionTurns) {
        const failed = state.lastRun && state.lastRun.ok === false
          ? `，上次运行失败 ${larkMemoryErrorLabel(typeof state.lastRun.error === 'string' ? state.lastRun.error : undefined)}` : '';
        stalled.push(`${where}：连续 ${human} 轮已完成的任务没有提取成功，上次成功提取 ${lastSuccess}${failed}`);
      }
      observed.push(`${where} 上次成功提取 ${lastSuccess}${manual ? '（已关闭自动提取）' : running ? '（提取进行中）' : ''}`);
    }
  }

  if (stalled.length) {
    return {
      ...base,
      level: 'warn',
      detail: stalled.join('；'),
      remedy: '在对应群里发送 /memory 查看后台状态；/memory consolidate 会立即补一次提取再整理。持续失败时查看守护进程日志里的「会话记忆提取失败」。',
      verify: 'dutydeck doctor --json'
    };
  }
  if (!observed.length) return { ...base, level: 'skip', detail: '开启会话记忆的机器人还没有记下过任何轮次' };
  return { ...base, level: 'ok', detail: observed.join('；') };
}

// ─── 8. access.posture / access.token ────────────────────────────────────────

export type AccessMode = 'local' | 'token' | 'open';

export interface PostureObservation {
  mode: AccessMode;
  host: string;
  port: number;
  authEnabled: boolean;
  /** 正在运行的守护进程的实际 host/port/auth；与配置不一致时单独报出来。 */
  runningHost?: string;
  runningPort?: number;
  runningAuthEnabled?: boolean;
}

export function checkAccessPosture(observation: PostureObservation): DoctorCheck {
  const { mode, host, port, authEnabled } = observation;
  if (mode === 'open') {
    // 认证关闭 + 非回环绑定 = 整个网络都能开终端、驱动 Agent。这是最危险的姿态。
    return {
      id: 'access.posture',
      label: '访问姿态',
      level: 'fail',
      detail: `认证已关闭且监听在 ${host}:${port}（非仅本机）——同网络任何人都能打开终端并驱动 Agent`,
      remedy: `这等于把本机 shell 和所有 Agent 的控制权敞开给整个网络，没有 --unsafe-no-auth 时服务会拒绝启动。二选一：设置访问密码并重新开启访问认证（去掉 --no-auth 或 .env 里的 DUTYDECK_AUTH=false），或改回只监听本机（dutydeck setup --local-only）。`,
      command: 'dutydeck auth password set',
      verify: 'dutydeck doctor --json'
    };
  }
  if (mode === 'local' && !authEnabled) {
    return {
      id: 'access.posture',
      label: '访问姿态',
      level: 'warn',
      detail: `认证已关闭，但只监听 ${host}（仅本机可达）`,
      remedy: '当前只有本机能连，风险有限；但本机上的任何进程/用户都能无凭据操作 Dutydeck。若这台机器不是你独占的，请开启访问认证。',
      command: 'dutydeck restart --auth',
      verify: 'dutydeck doctor --json'
    };
  }
  if (mode === 'local') {
    return { id: 'access.posture', label: '访问姿态', level: 'ok', detail: `仅本机（${host}:${port}），认证开启` };
  }
  return {
    id: 'access.posture',
    label: '访问姿态',
    level: 'ok',
    detail: `监听 ${host}:${port}，访问认证开启（远程访问需带令牌，用 dutydeck auth token 获取）`
  };
}

/** 配置里的姿态 vs 正在跑的守护进程的姿态。不一致说明改了配置但没重启。 */
export function checkPostureDrift(observation: PostureObservation): DoctorCheck | undefined {
  const { host, port, authEnabled, runningHost, runningPort, runningAuthEnabled } = observation;
  if (runningHost === undefined && runningPort === undefined && runningAuthEnabled === undefined) return undefined;
  const hostDrift = runningHost !== undefined && runningHost !== host;
  const portDrift = runningPort !== undefined && runningPort !== port;
  const authDrift = runningAuthEnabled !== undefined && runningAuthEnabled !== authEnabled;
  if (!hostDrift && !portDrift && !authDrift) return undefined;
  const parts = [
    hostDrift ? `监听地址：运行中 ${runningHost} ≠ 配置 ${host}` : undefined,
    portDrift ? `监听端口：运行中 ${runningPort} ≠ 配置 ${port}` : undefined,
    authDrift ? `访问认证：运行中${runningAuthEnabled ? '开启' : '关闭'} ≠ 配置${authEnabled ? '开启' : '关闭'}` : undefined
  ].filter(Boolean).join('；');
  return {
    id: 'access.drift',
    label: '运行态与配置不一致',
    level: 'warn',
    detail: parts,
    remedy: '正在运行的守护进程用的是启动时的配置，之后的配置改动不会自动生效——你看到的行为仍是旧配置。重启守护进程让新配置生效。',
    command: 'dutydeck restart',
    verify: 'dutydeck status'
  };
}

export interface TokenObservation {
  mode: AccessMode;
  /** 是否存在非空令牌。绝不携带令牌本身。 */
  present: boolean;
  /** 数据库不可读时无法判断。 */
  unknown?: boolean;
}

/**
 * token 模式下缺令牌是 fail-closed 的真故障：每个非豁免请求都会 401。
 * 只判断存在性 —— 令牌值永不出现在报告里。
 */
export function checkAccessToken(observation: TokenObservation): DoctorCheck {
  if (observation.mode !== 'token') {
    return {
      id: 'access.token',
      label: '访问令牌',
      level: 'skip',
      detail: observation.mode === 'local' ? '仅本机模式，不需要令牌' : '认证已关闭，不使用令牌'
    };
  }
  if (observation.unknown) {
    return { id: 'access.token', label: '访问令牌', level: 'skip', detail: '数据库不可读，无法确认令牌是否存在' };
  }
  if (!observation.present) {
    return {
      id: 'access.token',
      label: '访问令牌',
      level: 'fail',
      detail: '认证已开启但没有访问令牌，所有请求都会被拒绝（401）',
      remedy: '访问认证开着却没有令牌，等于谁都进不来。生成一个令牌（守护进程首次启动时也会自动生成一个）。',
      command: 'dutydeck auth token',
      verify: 'dutydeck auth token'
    };
  }
  return { id: 'access.token', label: '访问令牌', level: 'ok', detail: '已存在（值不在此显示，用 dutydeck auth token 查看）' };
}

// ─── 9. port.conflict ────────────────────────────────────────────────────────

export interface PortObservation {
  host: string;
  port: number;
  outcome: PortProbeOutcome;
  /** 占用者是不是我们自己的守护进程。 */
  ownDaemon: boolean;
}

/** 查占用者的命令按平台给：Linux 上 lsof 常常没装。 */
function holderCommand(port: number, platform: string): string {
  return platform === 'linux'
    ? `ss -ltnp 'sport = :${port}'`
    : `lsof -iTCP:${port} -sTCP:LISTEN -n -P`;
}

export function checkPort(observation: PortObservation, platform: string): DoctorCheck {
  const { host, port, outcome, ownDaemon } = observation;
  if (outcome === 'occupied' && ownDaemon) {
    // 占用者就是我们自己 —— 这正是健康状态，不是冲突。
    return { id: 'port.conflict', label: '端口占用', level: 'ok', detail: `${port} 由本机 Dutydeck 守护进程占用（就是它自己）` };
  }
  if (outcome === 'occupied') {
    return {
      id: 'port.conflict',
      label: '端口占用',
      level: 'fail',
      detail: `${host}:${port} 已被其他进程占用，Dutydeck 起不来`,
      remedy: `端口 ${port} 被别的程序占着，而它不是 Dutydeck 的守护进程。要么停掉那个程序，要么把 Dutydeck 换到别的端口。`,
      command: `dutydeck setup --port <其他端口>`,
      verify: holderCommand(port, platform)
    };
  }
  if (outcome === 'unknown') {
    return {
      id: 'port.conflict',
      label: '端口占用',
      level: 'warn',
      detail: `${host}:${port} 占用情况探测不出来（可能是权限不足或探测超时）`,
      remedy: `无法确认端口 ${port} 是否可用（低于 1024 的端口通常需要特权，也可能是探测超时）。手工确认一下谁在监听。`,
      command: holderCommand(port, platform),
      verify: 'dutydeck status'
    };
  }
  return { id: 'port.conflict', label: '端口占用', level: 'ok', detail: `${host}:${port} 可用` };
}

// ─── 10. platform.pickers ────────────────────────────────────────────────────

/** 与 system-routes.ts 的 `platform === 'darwin'` 保持一致（只复刻这一行判断，不打 HTTP）。 */
export function checkPlatformPickers(platform: string): DoctorCheck {
  if (platform === 'darwin') {
    return { id: 'platform.pickers', label: '原生目录选择器', level: 'ok', detail: 'macOS：可在面板里图形化选择目录与文件' };
  }
  return {
    id: 'platform.pickers',
    label: '原生目录选择器',
    level: 'info',
    detail: `${platform} 平台没有原生选择器，工作目录需要手工输入绝对路径`,
    verify: 'dutydeck setup --cwd <绝对路径>'
  };
}

// ─── 11. autostart ──────────────────────────────────────────────────────────

export function checkAutostart(result: DoctorAutostartResult | undefined, username: string): DoctorCheck[] {
  if (!result) {
    // autostart 模块尚未落地或加载失败时如实 skip，绝不让体检整体崩掉。
    return [{ id: 'autostart', label: '开机自启', level: 'skip', detail: '开机自启模块不可用，跳过' }];
  }
  const state = result.state;
  if (state.supported === false) {
    return [{
      id: 'autostart',
      label: '开机自启',
      level: 'info',
      detail: `${state.platform ?? '当前'} 平台不支持自动注册开机自启（仅 macOS launchd 与 Linux user systemd）`,
      verify: 'dutydeck start'
    }];
  }
  const checks: DoctorCheck[] = [];
  if (!state.enabled) {
    checks.push({
      id: 'autostart',
      label: '开机自启',
      level: 'info',
      detail: '未注册：重启或重新登录后 Dutydeck 不会自动起来',
      remedy: '若希望开机/登录后自动拉起 Dutydeck，注册开机自启（只登记引导钩子，不会立刻启动服务）。',
      command: 'dutydeck autostart enable',
      verify: 'dutydeck autostart status'
    });
    return checks;
  }
  checks.push({
    id: 'autostart',
    label: '开机自启',
    level: 'ok',
    detail: `已注册${state.unitPath ? `：${state.unitPath}` : ''}`
  });
  if (state.stale) {
    checks.push({
      id: 'autostart.stale',
      label: '开机自启已漂移',
      level: 'warn',
      detail: `磁盘上的启动配置与当前 node / dutydeck 路径不一致${state.unitPath ? `（${state.unitPath}）` : ''}`,
      remedy: '换过 node 版本或升级过 npm 包后，已登记的启动路径会静默失效——重启后服务再也起不来，且不会有任何报错。重新执行一次 enable 即可用当前路径刷新。',
      command: 'dutydeck autostart enable',
      verify: 'dutydeck autostart status'
    });
  }
  if (state.platform === 'linux' && state.lingerEnabled === false) {
    checks.push({
      id: 'autostart.linger',
      label: 'systemd linger',
      level: 'warn',
      detail: '未开启 linger：注销当前登录会话后服务会被系统杀掉',
      remedy: 'user systemd 默认在用户注销时回收其所有服务。要让 Dutydeck 跨注销/重启常驻，需要为该用户开启 linger（可能需要 sudo）。',
      command: `loginctl enable-linger ${username}`,
      verify: `loginctl show-user ${username} --property=Linger`
    });
  }
  return checks;
}

// ─── 汇总 ────────────────────────────────────────────────────────────────────

export function summarize(checks: readonly DoctorCheck[]): { ok: number; warn: number; fail: number; skip: number } {
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) {
    // info 刻意不进任何计数桶：它既不是通过项也不是问题项，计进 ok 会虚报体检通过数。
    if (check.level === 'ok') summary.ok += 1;
    else if (check.level === 'warn') summary.warn += 1;
    else if (check.level === 'fail') summary.fail += 1;
    else if (check.level === 'skip') summary.skip += 1;
  }
  return summary;
}

/** ui.status 的等级与 CheckLevel 同名的部分可以直接透传。 */
export function statusLevelFor(level: CheckLevel): 'ok' | 'warn' | 'fail' | 'info' | 'skip' {
  return level;
}
