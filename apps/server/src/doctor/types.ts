/**
 * `dutydeck doctor` 的类型契约与可注入依赖。
 *
 * 单独成文件的原因：checks.ts 与 doctor.ts 互相需要这些类型，放在任一侧都会形成
 * 循环 import。类型在运行时被擦除，但依赖注入的默认实现是真值，必须避免环。
 */
import type { CliUi } from '../cli-ui.js';

/** 检查结果等级。与 cli-ui 的 StatusLevel 取交集，可直接透传给 ui.status。 */
export type CheckLevel = 'ok' | 'warn' | 'fail' | 'skip' | 'info';

export interface DoctorCheck {
  /** 稳定的机器可读 id，例如 'node.version'。JSON 消费方按它做筛选。 */
  id: string;
  /** 简体中文短标签。 */
  label: string;
  level: CheckLevel;
  /** 观测到的实际值，或判定理由。 */
  detail?: string;
  /** 补救说明 —— 每个 fail/warn 必须有。绝不允许只报 FAILED 不给修法。 */
  remedy?: string;
  /** 可直接执行的补救命令。 */
  command?: string;
  /** 可选的验证命令，用于确认修好了。 */
  verify?: string;
  /** 文档链接。 */
  link?: string;
}

export interface DoctorReport {
  /** 有且仅有存在 level==='fail' 时为 false；仅有警告仍然算通过。 */
  ok: boolean;
  action: 'doctor';
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; fail: number; skip: number };
  /** 终态说明，或第一条该跑的补救命令。 */
  next: string;
}

export interface DoctorOptions {
  /** 机器消费模式：只输出单行 JSON，不产出任何人类可读文本。 */
  json?: boolean;
}

/** 体检关心的 AppConfig 子集；避免让测试构造完整的 AppConfig。 */
export interface DoctorConfig {
  host: string;
  port: number;
  authEnabled: boolean;
  databaseUrl: string;
  acpxCommand?: string;
  agents: ReadonlyArray<{ id: string; name: string; command: string; version?: string; protocol?: string }>;
}

/** daemon 落盘记录中体检需要的字段（对齐 DaemonState）。 */
export interface DoctorDaemonRecord {
  pid?: number;
  ready?: boolean;
  startedAt?: string;
  cwd?: string;
  database?: string;
  host?: string;
  port?: number;
  address?: string;
  authEnabled?: boolean;
}

/** daemonStatus() 的返回子集（对齐 DaemonStatusInfo）。 */
export interface DoctorDaemonStatus {
  running: boolean;
  pid?: number;
  address?: string;
  logFile?: string;
  startedAt?: string;
  ready?: boolean;
  authEnabled?: boolean;
}

/**
 * 只读数据库探测结果。
 *
 * 刻意不把打开的 handle 交给调用方：句柄逃逸出探针就没人保证它会被关掉。
 * 需要的键一次读完即关，因此这里只有值，没有连接。
 */
export interface DatabaseProbeResult {
  /** 库文件是否已存在。false 表示尚未初始化 —— 体检绝不为了检查而建库。 */
  exists: boolean;
  /** 打开或读取失败的原因（权限、损坏等）。 */
  error?: string;
  /** schema_migrations 中已应用的最高版本；读不到时 undefined。 */
  appliedVersion?: number;
  /** 请求的 configs 键值；键存在但无值时为 undefined。按前缀读到的键也并在这里。 */
  values?: Readonly<Record<string, string | undefined>>;
}

/**
 * keys 是精确键；prefixes 里的每个前缀会把 configs 表中以它开头的全部键一并读出，
 * 用于事先不知道完整键名的记录（例如按机器人与记忆池分键的 `lark.memory.state.*`）。
 */
export type DatabaseProbe = (path: string, keys: readonly string[], prefixes?: readonly string[]) => Promise<DatabaseProbeResult> | DatabaseProbeResult;

/**
 * 端口探测结果。
 *
 * 'unknown' 是刻意保留的第三态：低端口 EACCES、探测超时都属于「探不出来」，
 * 把它们当成 'free' 会让体检对着一个真被占用的端口报 ok。
 */
export type PortProbeOutcome = 'free' | 'occupied' | 'unknown';
export type PortProbe = (host: string, port: number, timeoutMs: number) => Promise<PortProbeOutcome>;

/** autostartStatus() 的返回子集；用 structural 类型以便该模块缺失时也能编译。 */
export interface DoctorAutostartState {
  platform?: string;
  supported?: boolean;
  enabled?: boolean;
  running?: boolean;
  unitPath?: string;
  lingerEnabled?: boolean;
  stale?: boolean;
}
export interface DoctorAutostartResult {
  state: DoctorAutostartState;
  notices?: readonly string[];
}

/** 当前用户名探测，用于 loginctl enable-linger 提示里给出真实用户名。 */
export interface DoctorFsStat {
  mode: number;
}

export interface DoctorDependencies {
  /** 渲染目标；默认 createCliUi()。 */
  ui?: CliUi;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 默认 process.version（形如 'v22.12.0'）。 */
  nodeVersion?: string;
  /** 默认 process.platform。 */
  platform?: string;
  /** 默认 os.userInfo().username，仅用于拼 linger 提示。 */
  username?: string;
  /** daemonStatus() 的注入点。 */
  daemonStatus?: () => DoctorDaemonStatus;
  /**
   * 原始 daemon 记录读取。必须与 daemonStatus 分开注入：daemonStatus 会把
   * 死掉的 pid 折叠成 running:false，与「从未启动过」不可区分。
   */
  daemonRecord?: () => DoctorDaemonRecord | undefined;
  /** daemon 目录下的日志文件路径，用于崩溃后引导用户去看日志。 */
  daemonLogFile?: string;
  /**
   * 已解析配置。省略时才会调用 loadConfig(env) —— 那个调用会 spawn 每个已知
   * Agent CLI 探版本（秒级），因此全流程只允许发生一次，并与 agents 检查共享。
   */
  config?: DoctorConfig;
  /** 只读数据库探针。 */
  databaseProbe?: DatabaseProbe;
  /** 端口探针。 */
  portProbe?: PortProbe;
  /** 端口探测超时（ms），默认 1000。 */
  portProbeTimeoutMs?: number;
  /** 期望的 migration 头版本；见 checks.ts 里 schema.migrations 的注释。 */
  expectedSchemaVersion?: number;
  /** 路径存在性判断，默认 fs.existsSync。 */
  exists?: (path: string) => boolean;
  /** 可写性判断（W_OK）；抛错即视为不可写。默认 fs/promises.access。 */
  access?: (path: string, mode: number) => Promise<void>;
  /** 取 mode 位用于权限收紧检查。默认 fs/promises.stat。 */
  stat?: (path: string) => Promise<DoctorFsStat>;
  /**
   * autostart 状态。省略时动态 import '../autostart/autostart.js'；
   * 该模块不存在或抛错时该项检查降级为 skip，而不是让整个体检崩掉。
   */
  autostartStatus?: () => Promise<DoctorAutostartResult>;
}
