/**
 * Lark OpenAPI 网关：per-appId 的跨会话限流 + 退避重试 + 熔断器。
 *
 * 背景：Dockmux 目前只有 per-session 限流（coordinator.ts 的 cardRateLimitedUntil
 * + larkRateLimitBackoffMs 只护住单个会话的心跳），没有任何跨会话 / per-app 的 QPS
 * 闸门。50 个并发会话 × 约 0.5 QPS 的卡片 PATCH ≈ 25 QPS，打在约 15 QPS 的 app 配额
 * 上必然产生 429 风暴：每个会话单看都很守规矩，合起来把整个 app 的配额打爆。本模块
 * 以 appId 为 key 收口所有出网 Lark 调用（卡片 create/patch、消息发送、表情回复、
 * 通讯录查询），把 N 个会话的并发写平滑到 app 配额以内。
 *
 * 三层机制（均以 appId 为 key，多 bot 互不影响）：
 *   1. Token bucket —— 默认 15 QPS / burst = qps，等待 >100ms 打 warn（带 appId +
 *      op），让限流排队可观测而不是静默堆积。
 *   2. 瞬时错误指数退避重试 —— 默认最多 3 次（500ms 起，上限 8s），尊重
 *      Retry-After / x-ogw-ratelimit-reset（两者单位都是秒，取 max 后有绝对上限）。
 *   3. 熔断器 —— 30s 窗口内连续 5 次瞬时失败跳闸，跳闸期间快速失败
 *      （LarkCircuitOpenError）；30s 后放一次半开探测，成功即恢复（info 日志），
 *      失败则重新跳闸。
 *
 * 对调用方透明：内部重试后仍失败会抛出**原始错误对象**，所以现有 call site 的
 * isLarkMessageRateLimit / isLarkCardContentRejected / isLarkMessageUnupdatable
 * 判断完全不受影响，业务层重试（coordinator / reconciler）仍在 gate 之外照常工作。
 *
 * ⚠️ 不允许 import service.ts：service.ts 会 import 本模块，反向依赖会成环。因此
 * 这里不能用 `instanceof LarkServiceError`，所有错误分类必须是结构化 / 鸭子类型的。
 * card-renderer.ts 同样不能 import（它第 3 行 import 了 service.ts，会经由它成环），
 * 所以瞬时/确定性判定在本文件内自包含实现，语义与 card-renderer 的
 * isLarkMessageRateLimit（230020）保持一致。owner-identity.ts 是零 import 的叶子
 * 模块，复用它的 larkErrorCode 不会成环。
 */
import { larkErrorCode } from './owner-identity.js';

/** 日志下沉口：与 listener.ts 的 ListenerLog 同形，便于 bootstrap 直接注入。 */
export type LarkGateLog = {
  info(details: unknown, message?: string): void;
  warn(details: unknown, message?: string): void;
  error(details: unknown, message?: string): void;
};

export interface LarkGateConfig {
  /** token bucket 填充速率（req/s），默认 15。 */
  qps: number;
  /** 桶容量（突发额度），默认 = qps。 */
  burst: number;
  /** 瞬时错误最大重试次数，默认 3；0 表示不重试。 */
  retryMaxAttempts: number;
  /** 退避基数（ms），默认 500。 */
  retryBaseMs: number;
  /** 单次退避上限（ms），默认 8000。 */
  retryMaxMs: number;
  /** 熔断阈值（窗口内连续瞬时失败次数），默认 5。 */
  circuitFailureThreshold: number;
  /** 失败计数窗口（ms），默认 30000。 */
  circuitWindowMs: number;
  /** 跳闸后放半开探测的间隔（ms），默认 30000。 */
  circuitProbeIntervalMs: number;
}

export interface LarkGateOptions {
  /** 调用方取消信号；令牌等待与退避睡眠都会响应。 */
  signal?: AbortSignal;
  /** 单次调用的日志下沉口，覆盖模块级 setLarkGateLog。 */
  log?: LarkGateLog;
  /** 配置来源，默认 process.env（每次调用现读，支持不重启调 QPS）。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 瞬时飞书业务码：即使 HTTP 状态是 4xx 也值得重试。
 *   230049   —— 发送频率过快（frequency limit）
 *   230020   —— 消息频控（card-renderer.isLarkMessageRateLimit 用的就是这个码）
 *   99991400 —— 网关频控 / 后端抖动
 * 这三个码飞书是按“客户端错误”返回的，但语义上是频控而非请求本身有问题，
 * 直接透出会让卡片更新白白丢一帧。
 */
const TRANSIENT_LARK_CODES = new Set([230049, 230020, 99991400]);

/**
 * Dockmux 自己抛的 transport 层错误码（service.ts request()）。只有被明确识别为
 * “出网请求失败”的错误才参与重试/熔断判定；INVALID_CARD_STATE、LARK_NOT_CONFIGURED
 * 这类本地校验错误必须原样快速抛出。
 */
const LARK_NETWORK_ERROR_CODE = 'LARK_NETWORK_ERROR';
const LARK_OPENAPI_ERROR_CODE = 'LARK_OPENAPI_ERROR';

// ─── env 解析 ─────────────────────────────────────────────────────────────────

function positiveFinite(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Math.floor(positiveFinite(raw, fallback));
  return value >= 1 ? value : fallback;
}

/** 允许 0（“不重试”是合法配置），但拒绝负数 / NaN。 */
function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/**
 * 读 env 构建网关配置。env 名沿用本目录 Lark OpenAPI 层的 LARK_* 约定
 * （对齐 LARK_OPEN_API_BASE_URL / LARK_APP_ID）：
 *   LARK_API_QPS、LARK_API_BURST、LARK_API_RETRY_MAX_ATTEMPTS、
 *   LARK_API_RETRY_BASE_MS、LARK_API_RETRY_MAX_MS、
 *   LARK_API_CIRCUIT_FAILURE_THRESHOLD、LARK_API_CIRCUIT_WINDOW_MS、
 *   LARK_API_CIRCUIT_PROBE_INTERVAL_MS
 *
 * 每次 executeWithLarkGate 都重新调用本函数，所以 daemon 运行期间改 env 即可调
 * QPS，不需要重启；非法值（NaN / 负数 / 0 / 空串）一律回退默认，绝不产出
 * NaN 或 0 QPS——0 QPS 会让所有卡片更新永久挂死。
 */
export function resolveLarkGateConfig(env: NodeJS.ProcessEnv = process.env): LarkGateConfig {
  const qps = positiveFinite(env.LARK_API_QPS, 15);
  return {
    qps,
    burst: positiveFinite(env.LARK_API_BURST, qps),
    retryMaxAttempts: nonNegativeInt(env.LARK_API_RETRY_MAX_ATTEMPTS, 3),
    retryBaseMs: positiveInt(env.LARK_API_RETRY_BASE_MS, 500),
    retryMaxMs: positiveInt(env.LARK_API_RETRY_MAX_MS, 8_000),
    circuitFailureThreshold: positiveInt(env.LARK_API_CIRCUIT_FAILURE_THRESHOLD, 5),
    circuitWindowMs: positiveInt(env.LARK_API_CIRCUIT_WINDOW_MS, 30_000),
    circuitProbeIntervalMs: nonNegativeInt(env.LARK_API_CIRCUIT_PROBE_INTERVAL_MS, 30_000)
  };
}

// ─── 熔断错误 ─────────────────────────────────────────────────────────────────

/**
 * 熔断器跳闸期间由 executeWithLarkGate 直接抛出：请求根本没有触达网络。
 * 刻意不继承 LarkServiceError（那会成环），调用方按结构判断或 instanceof 本类。
 */
export class LarkCircuitOpenError extends Error {
  constructor(readonly appId: string, readonly openedAt: number) {
    // 运维向文案：带 appId 与跳闸时刻，方便直接对齐日志。appId 不是凭据，
    // appSecret / token 一律不出现在任何日志或错误信息里。
    super(`飞书 OpenAPI 熔断器已跳闸（应用 ${appId}，跳闸于 ${new Date(openedAt).toISOString()}），本次请求未发出，请稍后重试。`);
    this.name = 'LarkCircuitOpenError';
  }
}

// ─── 错误分类（自包含，鸭子类型） ─────────────────────────────────────────────

type ErrorLike = {
  code?: unknown;
  name?: string;
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  details?: Record<string, unknown>;
  isAxiosError?: boolean;
  config?: unknown;
  response?: { status?: unknown; data?: { code?: unknown }; headers?: unknown };
  data?: { code?: unknown };
} | null | undefined;

/**
 * 提取飞书业务码。优先 details.upstreamCode —— 这是 Dockmux 的 LarkServiceError
 * 放置上游业务码的位置（service.ts request()）；其次交给 owner-identity 的
 * larkErrorCode 兜住 SDK / axios / 归一化后的 contact 错误形态；最后从消息尾部的
 * `(code: NNN)` 兜底（service.ts 的多处错误信息都带这个后缀）。
 */
function larkBusinessCode(err: unknown): number | undefined {
  const value = err as ErrorLike;
  const upstream = value?.details?.upstreamCode;
  if (typeof upstream === 'number' && Number.isFinite(upstream)) return upstream;
  if (typeof upstream === 'string' && /^\d+$/.test(upstream)) return Number(upstream);

  // larkErrorCode 覆盖 err.response.data.code / err.data.code / err.code 三种形态。
  // LarkServiceError 的 code 是 'LARK_OPENAPI_ERROR' 这类字符串，过不了它的数字
  // 校验，所以不会误判。
  const dug = larkErrorCode(err);
  if (dug !== undefined) return dug;

  const message = typeof value?.message === 'string' ? value.message : '';
  const matched = /\(code:\s*(\d+)\)/.exec(message);
  const captured = matched?.[1];
  return captured === undefined ? undefined : Number(captured);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * 提取**上游** HTTP 状态。
 *
 * 关键坑：LarkServiceError.statusCode 恒为 502（那是 Dockmux 回给自己 HTTP 客户端
 * 的状态），**不是**飞书返回的状态。真正的上游状态在 details.upstreamHttpStatus。
 * 所以这里绝不能读 statusCode，否则每个 OpenAPI 错误都会被当成 5xx 无脑重试。
 */
function upstreamHttpStatus(err: unknown): number | undefined {
  const value = err as ErrorLike;
  const detailed = finiteNumber(value?.details?.upstreamHttpStatus);
  if (detailed !== undefined) return detailed;
  const fromResponse = finiteNumber(value?.response?.status);
  if (fromResponse !== undefined) return fromResponse;
  return finiteNumber(value?.status);
}

/**
 * 这个错误是否是一次“出网请求失败”？只有被正面识别的 transport 错误才允许参与
 * 重试与熔断计数。默认否——这样 buildLarkCard 的参数校验错误、测试注入的普通
 * Error、编码 bug 都会立刻原样抛出，既不重试也不会污染电路。
 */
function looksLikeLarkTransportError(err: unknown): boolean {
  const value = err as ErrorLike;
  if (!value || typeof value !== 'object') return false;
  if (value.code === LARK_NETWORK_ERROR_CODE || value.code === LARK_OPENAPI_ERROR_CODE) return true;
  // axios / 飞书 SDK 形态（contact 系列接口走 SDK，抛的是 axios 错误）。
  if (value.isAxiosError === true || value.name === 'AxiosError') return true;
  if (value.config != null && (value.response != null || value.status != null)) return true;
  // 归一化过的 SDK 错误（normalizeContactError）：带数字业务码 + 上游状态。
  return upstreamHttpStatus(err) !== undefined && larkBusinessCode(err) !== undefined;
}

/**
 * 判断错误是否值得重试：
 *   - 命中 TRANSIENT_LARK_CODES 的业务码 → 重试（即使 HTTP 4xx，因为这些码是频控
 *     或后端抖动，不是请求本身错了）
 *   - 非 transport 错误 → 不重试
 *   - 无上游状态（LARK_NETWORK_ERROR / 连接失败）→ 重试
 *   - 上游 429 / 5xx → 重试
 *   - 其他 4xx（密钥错误、参数错误、内容被拒 230028/230099、消息不可更新
 *     230012/230030）→ 确定性错误，不重试
 */
export function isRetryableLarkError(err: unknown): boolean {
  const code = larkBusinessCode(err);
  if (code !== undefined && TRANSIENT_LARK_CODES.has(code)) return true;
  if (!looksLikeLarkTransportError(err)) return false;
  const status = upstreamHttpStatus(err);
  if (status === undefined) return true; // 网络错误：请求可能压根没发出去。
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

// ─── Retry-After / x-ogw-ratelimit-reset ──────────────────────────────────────

const retryAfterHeaderNames = ['retry-after', 'x-ogw-ratelimit-reset'];

function headerSeconds(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const getter = (headers as { get?: unknown }).get;
  // fetch 的 Headers 实例只能用 get() 读；普通对象直接按小写/原样键取。
  const read = typeof getter === 'function'
    ? (name: string) => (getter as (key: string) => unknown).call(headers, name)
    : (name: string) => {
      const bag = headers as Record<string, unknown>;
      return bag[name] ?? bag[name.replace(/(^|-)([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase())];
    };
  let best: number | undefined;
  for (const name of retryAfterHeaderNames) {
    const seconds = finiteNumber(read(name));
    if (seconds !== undefined && seconds > 0) best = best === undefined ? seconds : Math.max(best, seconds);
  }
  return best;
}

/**
 * 从错误对象里取出服务端要求的等待时长（ms）。
 *
 * service.ts 目前把 Response headers 丢掉了，所以网关只能通过错误对象拿到这个
 * 提示。契约（wave 2 由 service.ts 填充）：
 *   - details.retryAfterMs：**毫秒**，service.ts 已把秒换算好，优先采用；
 *   - details.retryAfterHeaders：原始响应头包（Headers 实例或普通对象均可），
 *     其中 retry-after 与 x-ogw-ratelimit-reset 的单位是**秒**，两者取 max。
 * 另外兼容 axios 形态的 err.response.headers，让走 SDK 的 contact 调用也能受益。
 */
function retryAfterHintMs(err: unknown): number | undefined {
  const value = err as ErrorLike;
  const explicit = finiteNumber(value?.details?.retryAfterMs);
  if (explicit !== undefined && explicit > 0) return explicit;
  const seconds = headerSeconds(value?.details?.retryAfterHeaders) ?? headerSeconds(value?.response?.headers);
  return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * 退避时长：指数退避与服务端头提示取 max（服务端说要等 30s 就不能只等 1s），
 * 但有绝对上限 retryMaxMs * 4，避免一个畸形的 Retry-After 头把请求挂死几小时。
 */
function computeBackoffMs(config: LarkGateConfig, attempt: number, err: unknown): number {
  const backoff = Math.min(config.retryBaseMs * 2 ** attempt, config.retryMaxMs);
  const hint = retryAfterHintMs(err);
  if (hint === undefined) return backoff;
  return Math.min(Math.max(backoff, hint), config.retryMaxMs * 4);
}

// ─── Token bucket ─────────────────────────────────────────────────────────────

/**
 * 容量与速率不存在构造函数里，而是每次调用现传：配置是 live 读 env 的，
 * 若把 qps 固化在桶实例上，改完 env 之后已存在的 app 仍按旧速率跑，等于配置没生效。
 */
class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(capacity: number, now: number) {
    this.tokens = capacity;
    this.lastRefillMs = now;
  }

  /** 距下一个令牌可用的等待 ms；0 表示当前就有令牌。 */
  waitTimeMs(now: number, capacity: number, ratePerSec: number): number {
    this.refill(now, capacity, ratePerSec);
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / ratePerSec) * 1000);
  }

  consume(now: number, capacity: number, ratePerSec: number): void {
    this.refill(now, capacity, ratePerSec);
    this.tokens -= 1;
  }

  private refill(now: number, capacity: number, ratePerSec: number): void {
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(capacity, this.tokens + elapsedSec * ratePerSec);
      this.lastRefillMs = now;
    }
  }
}

// ─── 熔断器状态 ───────────────────────────────────────────────────────────────

interface CircuitState {
  status: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  windowStartMs: number;
  openedAtMs: number;
}

// ─── 模块级 per-app 状态 ──────────────────────────────────────────────────────

const buckets = new Map<string, TokenBucket>();
const circuits = new Map<string, CircuitState>();

const noopLog: LarkGateLog = { info() {}, warn() {}, error() {} };
let moduleLog: LarkGateLog = noopLog;

/**
 * 注入模块级日志下沉口。本目录没有共享的模块级 logger（listener / coordinator 都
 * 用注入的 ListenerLog），而网关是模块级单例、没有注入点，所以默认 no-op：
 * 由 bootstrap（listener 装配处）调一次本函数把真实 log 接上，未接则静默。
 */
export function setLarkGateLog(log: LarkGateLog | undefined): void {
  moduleLog = log ?? noopLog;
}

function getBucket(appId: string, now: number, config: LarkGateConfig): TokenBucket {
  let bucket = buckets.get(appId);
  if (!bucket) {
    bucket = new TokenBucket(config.burst, now);
    buckets.set(appId, bucket);
  }
  return bucket;
}

function getCircuit(appId: string, now: number): CircuitState {
  let circuit = circuits.get(appId);
  if (!circuit) {
    circuit = { status: 'closed', consecutiveFailures: 0, windowStartMs: now, openedAtMs: 0 };
    circuits.set(appId, circuit);
  }
  return circuit;
}

/** 测试隔离：清空所有 app 的令牌桶 / 熔断器状态与日志下沉口。 */
export function __testOnly_resetLarkGate(): void {
  buckets.clear();
  circuits.clear();
  moduleLog = noopLog;
}

// ─── 等待 / 中止 ──────────────────────────────────────────────────────────────

function gateAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  // Node 的默认 abort reason 是 DOMException（instanceof Error 为 true），
  // 直接透出会变成 'This operation was aborted' 而丢掉网关语义；调用方显式
  // abort(customError) 传入的自定义原因仍原样透传。
  if (reason instanceof Error && reason.constructor.name !== 'DOMException') return reason;
  const error = new Error('飞书 OpenAPI 网关操作已取消。');
  error.name = 'AbortError';
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(gateAbortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(gateAbortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function acquireToken(
  appId: string,
  op: string,
  config: LarkGateConfig,
  log: LarkGateLog,
  signal?: AbortSignal
): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw gateAbortError(signal);
    const now = Date.now();
    const bucket = getBucket(appId, now, config);
    const waitMs = bucket.waitTimeMs(now, config.burst, config.qps);
    if (waitMs === 0) {
      bucket.consume(now, config.burst, config.qps);
      return;
    }
    // 让限流可观测：>100ms 的等待打 warn（带 appId + op），这样“50 会话卡片风暴
    // 把 app 配额打满”会在日志里显形，而不是静默排队让人以为飞书变慢了。
    if (waitMs > 100) {
      log.warn({ appId, op, waitMs, qps: config.qps }, '飞书 OpenAPI 限流等待');
    }
    await sleep(waitMs, signal);
  }
}

// ─── 熔断计数 ─────────────────────────────────────────────────────────────────

function recordTransientFailure(
  circuit: CircuitState,
  appId: string,
  op: string,
  config: LarkGateConfig,
  log: LarkGateLog,
  now: number
): void {
  if (circuit.status === 'half-open') {
    // 半开探测失败 → 立即重新跳闸，探测时钟从现在重新计时。
    circuit.status = 'open';
    circuit.openedAtMs = now;
    circuit.consecutiveFailures += 1;
    log.warn({ appId, op, failures: circuit.consecutiveFailures }, '飞书 OpenAPI 熔断器半开探测失败，重新跳闸');
    return;
  }
  if (now - circuit.windowStartMs > config.circuitWindowMs) {
    // 窗口外的失败不累计：旧失败已过期，重开窗口。否则一天里零散的 5 次失败
    // 也会跳闸。
    circuit.windowStartMs = now;
    circuit.consecutiveFailures = 1;
  } else {
    circuit.consecutiveFailures += 1;
  }
  if (circuit.consecutiveFailures >= config.circuitFailureThreshold) {
    circuit.status = 'open';
    circuit.openedAtMs = now;
    log.warn({ appId, op, failures: circuit.consecutiveFailures, probeIntervalMs: config.circuitProbeIntervalMs }, '飞书 OpenAPI 熔断器跳闸');
  }
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 在 per-app 限流 / 重试 / 熔断网关内执行一次 Lark 出网调用。
 *
 * 流程：熔断检查（open 且未到探测间隔 → 快速失败；到期 → 转半开放行一次）→
 * 取令牌 → 执行 fn → 成功则清零失败计数（半开转闭合并打 info）；失败且可重试 →
 * 指数退避（尊重 Retry-After）后重试；不可重试或重试耗尽 → 仅在瞬时错误时累计
 * 失败计数（可能跳闸），然后抛出**原始错误**。
 *
 * 除限流/重试引入的延迟外，不传 signal 的调用方行为与直接 await fn() 完全一致。
 */
export async function executeWithLarkGate<T>(
  appId: string,
  op: string,
  fn: () => Promise<T>,
  options?: LarkGateOptions
): Promise<T> {
  const config = resolveLarkGateConfig(options?.env);
  const log = options?.log ?? moduleLog;
  const signal = options?.signal;
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw gateAbortError(signal);
    const circuit = getCircuit(appId, Date.now());
    if (circuit.status === 'open') {
      if (Date.now() - circuit.openedAtMs < config.circuitProbeIntervalMs) {
        throw new LarkCircuitOpenError(appId, circuit.openedAtMs);
      }
      circuit.status = 'half-open';
      log.info({ appId, op }, '飞书 OpenAPI 熔断器进入半开，放行一次探测');
    }

    await acquireToken(appId, op, config, log, signal);
    // acquireToken 里的 await 会让出事件循环，调用方的 abort() 可能正好在这期间
    // 到达。这里必须复查：在**已经 aborted** 的 signal 上后注册的监听器永远不会
    // 触发，不提前抛出的话 fn 内部的请求会永久挂起（无人取消、也无人超时）。
    if (signal?.aborted) throw gateAbortError(signal);

    try {
      const result = await fn();
      circuit.consecutiveFailures = 0;
      if (circuit.status === 'half-open') {
        circuit.status = 'closed';
        log.info({ appId, op }, '飞书 OpenAPI 熔断器已恢复闭合');
      }
      return result;
    } catch (error) {
      const retryable = isRetryableLarkError(error);
      if (retryable && attempt < config.retryMaxAttempts) {
        const backoffMs = computeBackoffMs(config, attempt, error);
        attempt += 1;
        log.warn({ appId, op, attempt, maxAttempts: config.retryMaxAttempts, backoffMs }, '飞书 OpenAPI 调用失败，退避重试');
        await sleep(backoffMs, signal);
        continue;
      }
      // 熔断器只统计瞬时错误（429 / 5xx / 网络）。确定性错误（密钥错误、参数
      // 错误、内容被审核拒绝、消息不可更新）重试无意义，更不该跳闸：否则一条
      // 内容违规的卡片连发 5 次，就会把整个 app 的所有会话一起熔断——一个坏请求
      // 毒死整个 app。
      if (retryable) recordTransientFailure(circuit, appId, op, config, log, Date.now());
      throw error;
    }
  }
}
