/**
 * Session insight 来源解析（设计 3.3）。
 *
 * 唯一公开输入是 sessionId；日志根、repositories、instanceId 均为构造期内部依赖。
 * 解析顺序：枚举来源观察 / 全部 driver resources / 各 attempt 的 nativeContextRef 与
 * PTY checkpoint → 在已核准根内做有界候选发现 → realpath + 普通文件 + 内容原生 ID
 * 核验 → Claude 子 Agent 显式父子证明 → 追加本次发现的 historical proof → 返回来源清单。
 *
 * 身份红线：
 *  - 同 cwd / 最新 mtime / 文件名 UUID / pinned 文件存在，单独都不构成绑定证明。
 *  - 多个候选都通过内容核验时返回 ambiguous，绝不按时间选赢家。
 *  - marker 绝不能覆盖内容 ID 不匹配或缺失 session_meta；内容原生 ID 必须真实有效。
 *  - 发现被截断（limited）时，未完整排除冲突的 marker 发现不得假唯一绑定为 primary。
 *  - 路径是私有字段，只存在于本模块返回的内部来源；toSafeManifestEntries() 负责剥离。
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  SESSION_INSIGHT_LIMITS,
  type DriverResource,
  type FileRelationship,
  type InsightClient,
  type NativeContextRef,
  type ProofKind,
  type SessionInsightManifestSourceEntry,
  type SourceMatchStatus,
  type StreamIdentity,
  type TaskAttempt,
  type TranscriptSourceObservation,
} from '@dutydeck/shared';
import { buildSessionMarker } from '@dutydeck/pty-driver';

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export type InsightSourceRole = 'primary' | 'additional' | 'subagent' | 'excluded';

export interface ResolvedInsightSource {
  sourceKey: string;
  sourceSessionKey?: string;
  client: InsightClient;
  status: SourceMatchStatus;
  /** matched 时的私有核准根；绝不进入任何公开 DTO。 */
  approvedRoot?: string;
  /** matched 时的私有已核验 realpath；绝不进入任何公开 DTO。 */
  verifiedPath?: string;
  expectedNativeSessionId: string;
  expectedStream: StreamIdentity;
  proofKind: ProofKind;
  role: InsightSourceRole;
  discoveryLimited: boolean;
  reason?: string;
  relationship: FileRelationship;
  /** 核验证据描述（含行号），仅内部使用。 */
  evidenceRefs: string[];
  /** ACP live 引用（如有），内部使用。 */
  nativeContextRef?: NativeContextRef;
  /** 是否当前 active run 且由当前活动 driver 权威观察的来源。 */
  isCurrentRunObserved?: boolean;
}

export interface ResolveSessionInsightSourcesOptions {
  signal?: AbortSignal;
  /** epoch 毫秒；超过后中止后续发现。 */
  deadline?: number;
}

export interface ResolveSessionInsightSourcesResult {
  sources: ResolvedInsightSource[];
  primarySourceKey: string | null;
  /** 任一阶段命中了有界发现上限。 */
  discoveryLimited: boolean;
  /** matched 文件数超过 32：整 job 应 input_limit，而不是截最近文件。 */
  inputLimit: boolean;
  /** 整体只能展示宿主执行信息时的原因（无任何可核验来源 / 不支持的驱动）。 */
  hostOnlyReason?: string;
  /** 剥离全部私有路径后的公开投影。 */
  toSafeManifestEntries(): SafeManifestEntry[];
}

export type SafeManifestEntry = Pick<
  SessionInsightManifestSourceEntry,
  'sourceKey' | 'client' | 'matchStatus' | 'expectedStream' | 'relationship' | 'status'
>;

export interface CreateTranscriptSourceKeysFn {
  (
    instanceId: string,
    client: InsightClient,
    canonicalDataRoot: string,
    nativeSessionId: string | null | undefined,
    streamIdentity?: StreamIdentity
  ): { sourceSessionKey: string; sourceKey: string } | null | undefined;
}

/** 一个已核准的数据根（home 形态：claudeDataDir / codexHome / traeHome）。 */
export interface ConfiguredInsightRoot {
  client: InsightClient;
  path: string;
}

export interface SessionInsightResolverDependencies {
  repositories: {
    insight: import('@dutydeck/shared').SessionInsightRepository;
    sessions: import('@dutydeck/shared').SessionRepository;
    execution: import('@dutydeck/shared').ExecutionRepository;
    config: { get(key: string): Promise<string | undefined> };
    agents?: import('@dutydeck/shared').AgentRepository;
  };
  /**
   * 当前配置核准根（生产由接线方用 pty-driver cli-paths 按 session agent 的
   * 子进程 env 计算后注入）。观察记录携带的历史 dataRoot 会自动并入核准根集合，
   * 因此 HOME 切换后历史来源仍可在原根内核验。
   */
  configuredRoots?: ConfiguredInsightRoot[];
  /** 测试/内部注入；生产缺省读 config 'insight.instance_id'。 */
  instanceId?: string;
  /** T3c runtime helper（@dutydeck/runtime 导出）；不得在本文件复制 hash 算法。 */
  createTranscriptSourceKeys: CreateTranscriptSourceKeysFn;
  /** 测试用收窄常量，不新增生产配置面。 */
  limits?: Partial<ResolverScanLimits>;
}

export interface ResolverScanLimits {
  /** 整次解析遍历的目录 entry 元信息上限（设计 5.3：10,000）。 */
  maxCandidateMetas: number;
  /** 单个候选文件身份读取窗口。 */
  identityHeadBytes: number;
  /** 每个发现组最多做内容核验的文件数（newest-first 仅作为工作量边界）。 */
  maxContentScansPerGroup: number;
  /** 主流父子证明扫描窗口。 */
  proofScanBytes: number;
  /** 身份阶段总读取字节上限（不绕过 128MiB 快照预算）。 */
  maxIdentityReadBytes: number;
}

const DEFAULT_LIMITS: ResolverScanLimits = {
  maxCandidateMetas: SESSION_INSIGHT_LIMITS.maxDiscoveredCandidates,
  identityHeadBytes: 256 * 1024,
  maxContentScansPerGroup: 256,
  proofScanBytes: 4 * 1024 * 1024,
  maxIdentityReadBytes: SESSION_INSIGHT_LIMITS.maxTotalSnapshotBytes,
};

export const INSIGHT_INSTANCE_ID_CONFIG_KEY = 'insight.instance_id';

const ADAPTER_CLIENT: Record<string, InsightClient> = {
  'claude-code': 'claude',
  seed: 'claude',
  relay: 'claude',
  codex: 'codex',
  traex: 'traex',
};

const NO_RELATIONSHIP: FileRelationship = {
  kind: 'none',
  parentNativeSessionId: null,
  parentNativeAgentId: null,
  evidenceRefs: [],
};

// ---------------------------------------------------------------------------
// 内部声明
// ---------------------------------------------------------------------------

interface RootSet {
  path: string;
  client: InsightClient;
}

interface StreamClaim {
  correlation: string;
  client: InsightClient;
  canonicalRoot?: string;
  stream: StreamIdentity;
  nativeSessionId?: string;
  explicitPaths: string[];
  roots: RootSet[];
  observed: boolean;
  proof: ProofKind;
  nativeContextRef?: NativeContextRef;
  evidenceRefs: string[];
  currentRunObserved: boolean;
  ledgerSourceKey?: string;
  ledgerSourceSessionKey?: string;
  markerDiscovery?: boolean;
}

interface VerifiedFile {
  realPath: string;
  root: RootSet;
  nativeSessionId: string;
  cwd?: string;
  agentIds: Set<string>;
  sidechain: boolean;
  relationship?: FileRelationship;
}

interface JsonIdentity {
  nativeSessionId?: string;
  cwd?: string;
  agentIds: Set<string>;
  sidechain: boolean;
  relationship?: FileRelationship;
  conflictingSessionIds?: boolean;
}

interface VerifyContext {
  sessionId: string;
  sessionCwd?: string;
  claudeProjectKey?: string;
  checkCancelled: () => void;
  onIdentityRead: (bytes: number) => void;
  markLimited: () => void;
  incrementMetas: (count: number) => boolean;
}

export class ResolverAbortError extends Error {
  readonly code = 'INSIGHT_ABORTED';
  constructor() {
    super('Session insight source resolution aborted');
    this.name = 'ResolverAbortError';
  }
}

function fail(code: string, message: string, statusCode = 409): never {
  const error = new Error(message) as Error & { code: string; statusCode: number };
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function asNativeContextRef(value: unknown): NativeContextRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const ref = value as Record<string, unknown>;
  if (typeof ref.resourceId !== 'string' || typeof ref.identityId !== 'string' || typeof ref.originRunId !== 'string') {
    return undefined;
  }
  return { resourceId: ref.resourceId, identityId: ref.identityId, originRunId: ref.originRunId };
}

function mainStream(): StreamIdentity {
  return { kind: 'main', nativeAgentId: null };
}

function streamLabel(stream: StreamIdentity): string {
  return stream.kind === 'main' ? 'main' : `subagent:${stream.nativeAgentId}`;
}

/**
 * 来源相关键（含 canonicalRoot，确保跨根来源各自独立保留，不互相覆盖或串绑）。
 */
function stableCorrelation(
  client: InsightClient,
  canonicalRoot: string | undefined,
  nativeSessionId: string | undefined,
  stream: StreamIdentity
): string {
  return `${client}|${canonicalRoot ?? '*'}|${nativeSessionId ?? '?'}|${streamLabel(stream)}`;
}

async function canonicalRealPath(p: string): Promise<string | undefined> {
  try {
    return await realpath(resolve(p));
  } catch {
    return undefined;
  }
}

function isWithinRoot(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

/**
 * 真正基于 fd 有界读取前 maxBytes 字节，严禁读取整个大文件再在内存截断。
 * 1. lstat 检查普通文件；
 * 2. open 使用 O_RDONLY | O_NOFOLLOW | O_NONBLOCK，防止 FIFO 永久阻塞与符号链接追踪；
 * 3. fd.stat() 核对 dev/ino，防止路径替换与 TOCTOU；
 * 4. onIdentityRead 在文件 I/O 之后调用，确保限额 / 取消等受控异常绝不被底层错误吞没。
 */
async function readHeadBytes(
  realPath: string,
  maxBytes: number,
  onIdentityRead: (bytes: number) => void,
  checkCancelled?: () => void
): Promise<Buffer | undefined> {
  checkCancelled?.();
  let fd: import('node:fs/promises').FileHandle | undefined;
  let bytesRead = 0;
  let readBuf: Buffer | undefined;
  try {
    const beforeSt = await lstat(realPath);
    if (!beforeSt.isFile()) return undefined;

    fd = await open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const fdSt = await fd.stat();
    if (!fdSt.isFile() || fdSt.dev !== beforeSt.dev || fdSt.ino !== beforeSt.ino) {
      return undefined;
    }

    checkCancelled?.();
    const buf = Buffer.alloc(Math.max(0, maxBytes));
    const res = await fd.read(buf, 0, buf.length, 0);
    bytesRead = res.bytesRead;
    readBuf = buf.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await fd?.close().catch(() => undefined);
  }
  checkCancelled?.();
  onIdentityRead(bytesRead);
  return readBuf;
}

function completeLinePrefix(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  const lastNl = buf.lastIndexOf(0x0a);
  return lastNl >= 0 ? buf.subarray(0, lastNl + 1) : Buffer.alloc(0);
}

function parseJsonlBuffer(buf: Buffer): Array<{ line: number; value: any }> {
  const out: Array<{ line: number; value: any }> = [];
  let line = 0;
  for (const raw of buf.toString('utf8').split('\n')) {
    line += 1;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object') out.push({ line, value });
    } catch {
      // 忽略损坏的半行
    }
  }
  return out;
}

/** 有界目录遍历：全 job 共享 metadata 上限计数。 */
async function walkCandidates(
  root: string,
  accept: (name: string) => boolean,
  maxDepth: number,
  ctx: VerifyContext
): Promise<{ files: Array<{ path: string; mtimeMs: number }>; limited: boolean }> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  let limited = false;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    ctx.checkCancelled();
    const { dir, depth } = stack.pop()!;
    let directory: import('node:fs').Dir;
    try {
      directory = await opendir(dir);
    } catch {
      continue;
    }
    try {
      let entry: Dirent | null;
      // eslint-disable-next-line no-await-in-loop
      while ((entry = await directory.read().catch(() => null))) {
        if (!ctx.incrementMetas(1)) {
          ctx.markLimited();
          return { files, limited: true };
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
        } else if (entry.isFile() && accept(entry.name)) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const st = await lstat(full);
            if (st.isFile()) files.push({ path: full, mtimeMs: st.mtimeMs });
          } catch {
            // disappeared
          }
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
  return { files, limited };
}

/** 拒绝同一文件内多个互斥的 session id，避免首/末赢家。 */
function extractClaudeIdentity(lines: Array<{ line: number; value: any }>): JsonIdentity {
  const agentIds = new Set<string>();
  const sessionIds = new Set<string>();
  let cwd: string | undefined;
  let sidechain = false;
  for (const { value } of lines) {
    if (typeof value.sessionId === 'string' && value.sessionId.length > 0) {
      sessionIds.add(value.sessionId);
    }
    if (typeof value.cwd === 'string' && value.cwd.length > 0 && !cwd) cwd = value.cwd;
    if (typeof value.agentId === 'string' && value.agentId.length > 0) agentIds.add(value.agentId);
    if (value.isSidechain === true) sidechain = true;
  }
  if (sessionIds.size > 1) {
    return { agentIds, sidechain, conflictingSessionIds: true };
  }
  return { nativeSessionId: [...sessionIds][0], cwd, agentIds, sidechain };
}

function extractCodexFamilyRelationship(source: any): FileRelationship | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const parentFrom = (node: any): string | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    const id = node.parent_thread_id ?? node.parent_session_id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  };
  const forkNode = source.subagent?.thread_fork ?? (source.kind === 'fork' ? source : undefined);
  const forkParent = parentFrom(forkNode);
  if (forkParent) {
    return {
      kind: 'fork',
      parentNativeSessionId: forkParent,
      parentNativeAgentId: null,
      evidenceRefs: ['session_meta:source.subagent.thread_fork'],
    };
  }
  const spawnParent = parentFrom(source.subagent?.thread_spawn);
  if (spawnParent) {
    return {
      kind: 'unknown',
      parentNativeSessionId: spawnParent,
      parentNativeAgentId: null,
      evidenceRefs: ['session_meta:source.subagent.thread_spawn'],
    };
  }
  return undefined;
}

/** 拒绝同一个文件内多个互斥的 session_meta id。 */
function extractCodexFamilyIdentity(lines: Array<{ line: number; value: any }>): JsonIdentity {
  const sessionIds = new Set<string>();
  let cwd: string | undefined;
  let relationship: FileRelationship | undefined;
  for (const { value } of lines) {
    if (value?.type === 'session_meta') {
      const payload = value.payload;
      const id = payload?.id ?? payload?.session_id;
      if (typeof id === 'string' && id.length > 0) sessionIds.add(id);
      if (typeof payload?.cwd === 'string' && payload.cwd.length > 0 && !cwd) cwd = payload.cwd;
      relationship ??= extractCodexFamilyRelationship(payload?.source);
    }
  }
  if (sessionIds.size > 1) {
    return { agentIds: new Set(), sidechain: false, conflictingSessionIds: true };
  }
  return { nativeSessionId: [...sessionIds][0], cwd, agentIds: new Set(), sidechain: false, relationship };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export class SessionInsightResolver {
  private readonly deps: SessionInsightResolverDependencies;
  private readonly limits: ResolverScanLimits;

  constructor(deps: SessionInsightResolverDependencies) {
    this.deps = deps;
    this.limits = { ...DEFAULT_LIMITS, ...(deps.limits ?? {}) };
  }

  async resolveSessionInsightSources(
    sessionId: string,
    options: ResolveSessionInsightSourcesOptions = {}
  ): Promise<ResolveSessionInsightSourcesResult> {
    const checkCancelled = (): void => {
      if (options.signal?.aborted || (options.deadline !== undefined && Date.now() >= options.deadline)) {
        throw new ResolverAbortError();
      }
    };
    checkCancelled();

    const { repositories } = this.deps;
    const session = await repositories.sessions.get(sessionId);
    if (!session) fail('INSIGHT_NOT_FOUND', `Session ${sessionId} does not exist`, 404);

    const instanceId = await this.resolveInstanceId();
    const agent = session.agentId && repositories.agents
      ? await repositories.agents.get(session.agentId).catch(() => undefined)
      : undefined;
    const agentClient = agent ? ADAPTER_CLIENT[agent.adapterId ?? agent.id] : undefined;

    const [observations, resources, executions] = await Promise.all([
      Promise.resolve(repositories.insight.listSources(sessionId)),
      Promise.resolve(repositories.execution.getResources(sessionId)),
      Promise.resolve(repositories.execution.getSessionExecutions(sessionId)),
    ]);
    const currentSelection = repositories.execution.getNativeContext(sessionId)?.selection.context;

    // 当前 run 最新创建（created）的权威 driver 锚点。
    // 镜像 storage 与 T3c 锚点规则：
    //  - controlled lifecycle / strict-context-restore: 取 driverInstanceId
    //  - PTY local_only (kind === 'local_only' 且有 identity): 取 resourceId
    const currentRunDriverInstanceId = (() => {
      const anchors = resources.filter(
        r => r.sessionId === sessionId
          && r.runId === session.runId
          && r.stage === 'created'
          && (
            (r.kind === 'operation' && (r.operationScope?.kind === 'lifecycle' || r.operationScope?.kind === 'strict-context-restore'))
            || (r.kind === 'local_only' && Boolean(r.identity?.identityId))
          )
      );
      if (anchors.length === 0) return undefined;
      const latest = anchors[anchors.length - 1]!;
      return latest.kind === 'local_only' ? latest.resourceId : (latest.driverInstanceId ?? undefined);
    })();

    // 核准根：当前配置根 + 观察携带的历史 dataRoot。
    const rootsByClient = new Map<InsightClient, RootSet[]>();
    const addRoot = async (client: InsightClient, rawPath: string): Promise<string | undefined> => {
      const canonical = await canonicalRealPath(rawPath);
      if (!canonical) return undefined;
      const list = rootsByClient.get(client) ?? [];
      if (!list.some(root => root.path === canonical)) list.push({ path: canonical, client });
      rootsByClient.set(client, list);
      return canonical;
    };
    for (const root of this.deps.configuredRoots ?? []) {
      // eslint-disable-next-line no-await-in-loop
      await addRoot(root.client, root.path);
    }
    for (const obs of observations) {
      if (obs.dataRoot) {
        // eslint-disable-next-line no-await-in-loop
        await addRoot(obs.client, obs.dataRoot);
      }
    }

    const sessionCwd = (await canonicalRealPath(session.cwd)) ?? resolve(session.cwd);
    const claudeProjectKey = sessionCwd.replace(/[^A-Za-z0-9-]/g, '-');
    let discoveryLimited = false;
    let totalIdentityBytes = 0;
    let totalMetasVisited = 0;

    const markLimited = (): void => {
      discoveryLimited = true;
    };
    const chargeRead = (bytes: number): void => {
      totalIdentityBytes += bytes;
      if (totalIdentityBytes > this.limits.maxIdentityReadBytes) {
        const err = new Error(`Identity read limit exceeded: ${totalIdentityBytes} > ${this.limits.maxIdentityReadBytes}`) as Error & { code: string };
        err.code = 'INSIGHT_INPUT_LIMIT';
        throw err;
      }
    };
    const incrementMetas = (count: number): boolean => {
      totalMetasVisited += count;
      if (totalMetasVisited > this.limits.maxCandidateMetas) {
        discoveryLimited = true;
        return false;
      }
      return true;
    };

    const verifyContext: VerifyContext = {
      sessionId,
      sessionCwd,
      claudeProjectKey,
      checkCancelled,
      onIdentityRead: chargeRead,
      markLimited,
      incrementMetas,
    };

    const claims = new Map<string, StreamClaim>();
    const getClaim = (
      client: InsightClient,
      canonicalRoot: string | undefined,
      nativeSessionId: string | undefined,
      stream: StreamIdentity
    ): StreamClaim => {
      const correlation = stableCorrelation(client, canonicalRoot, nativeSessionId, stream);
      let claim = claims.get(correlation);
      if (!claim) {
        const matchingRoots = canonicalRoot
          ? [{ path: canonicalRoot, client }]
          : (rootsByClient.get(client) ?? []);
        claim = {
          correlation,
          client,
          canonicalRoot,
          stream,
          nativeSessionId,
          explicitPaths: [],
          roots: matchingRoots,
          observed: false,
          proof: 'inferred',
          currentRunObserved: false,
          evidenceRefs: [],
        };
        claims.set(correlation, claim);
      }
      return claim;
    };
    const strengthen = (claim: StreamClaim, proof: ProofKind): void => {
      const rank: Record<ProofKind, number> = { launch_observed: 3, historical_verified: 2, inferred: 1 };
      if (rank[proof] > rank[claim.proof]) claim.proof = proof;
    };

    // ---- 枚举 1：私有来源观察 -------------------------------------------
    for (const obs of observations) {
      if (!obs.nativeSessionId || !obs.streamIdentity) continue;
      // 保持根维度独立，防止跨根来源覆盖或错误合并
      const canonicalObsRoot = obs.dataRoot
        ? ((await canonicalRealPath(obs.dataRoot)) ?? resolve(obs.dataRoot))
        : undefined;
      const claim = getClaim(obs.client, canonicalObsRoot, obs.nativeSessionId, obs.streamIdentity);
      if (obs.verifiedPath && !claim.explicitPaths.includes(obs.verifiedPath)) {
        claim.explicitPaths.push(obs.verifiedPath);
      }
      claim.observed = true;
      strengthen(claim, obs.proofKind);
      if (obs.nativeContextRef) {
        const ref = asNativeContextRef(obs.nativeContextRef);
        if (ref) claim.nativeContextRef = ref;
      }
      // 必须是当前 run、launch_observed 且 driver 实例完全匹配当前活动 driver 才是当前 run 权威
      if (
        obs.activeRunId === session.runId &&
        obs.proofKind === 'launch_observed' &&
        currentRunDriverInstanceId !== undefined &&
        obs.driverInstanceId === currentRunDriverInstanceId
      ) {
        claim.currentRunObserved = true;
      }
      if (obs.sourceKey) claim.ledgerSourceKey = obs.sourceKey;
      if (obs.sourceSessionKey) claim.ledgerSourceSessionKey = obs.sourceSessionKey;
      claim.evidenceRefs.push(`observation:${obs.observationId}`);
    }

    // ---- 枚举 2：各 attempt 的 nativeContextRef 与 PTY checkpoint --------
    const referencedNativeResources = new Set<string>();
    for (const execution of executions) {
      for (const attempt of execution.attempts) {
        const ref = attempt.submission?.nativeContextRef;
        if (ref) referencedNativeResources.add(JSON.stringify(ref));
        this.collectCheckpointClaims(attempt, agentClient, getClaim, strengthen);
      }
    }

    const resourcesById = new Map(resources.map(resource => [resource.resourceId, resource]));
    for (const key of referencedNativeResources) {
      const ref = JSON.parse(key) as NativeContextRef;
      const resource = resourcesById.get(ref.resourceId);
      if (!resource || resource.purpose !== 'acp_native_context' || !resource.identity) continue;
      const identity = resource.identity.locator as {
        agent?: string;
        agentSessionId?: string;
        backendSessionId?: string;
      };
      const client = agentClient ?? (identity.agent ? ADAPTER_CLIENT[identity.agent] : undefined);
      if (!client) continue;
      const nativeSessionId = typeof identity.agentSessionId === 'string' && identity.agentSessionId.length > 0
        ? identity.agentSessionId
        : undefined;
      const claim = getClaim(client, undefined, nativeSessionId, mainStream());
      claim.nativeContextRef = ref;
      strengthen(claim, 'historical_verified');
      claim.evidenceRefs.push(`resource:${ref.resourceId}`);
      if (currentSelection && JSON.stringify(currentSelection) === JSON.stringify(ref)) {
        claim.currentRunObserved = true;
      }
    }

    // ---- 不支持驱动与旧会话 marker 历史发现兜底 ------------------------
    if (claims.size === 0 && !agentClient) {
      return this.hostOnlyResult('unsupported_driver');
    }
    if (agentClient && ![...claims.values()].some(
      claim => claim.client === agentClient && claim.stream.kind === 'main'
    )) {
      const markerClaim = getClaim(agentClient, undefined, undefined, mainStream());
      markerClaim.roots = rootsByClient.get(agentClient) ?? [];
      markerClaim.markerDiscovery = true;
      markerClaim.evidenceRefs.push('discovery:session_marker');
    }

    // ---- 核验每个 claim -------------------------------------------------
    const resolved: ResolvedInsightSource[] = [];
    const matchedMains: ResolvedInsightSource[] = [];
    const historicalAppends: Array<{ claim: StreamClaim; file: VerifiedFile }> = [];
    /**
     * 已预核验的 Claude 子流文件（来自持久 observation / 显式路径）。
     * 子流绝不能在主循环直接定终态：必须等其所属 main 的显式 Agent tool_result
     * 父子证明在 resolveClaudeSubagents 中通过后才认领，否则第二次解析会把
     * 历史子记录错误保留为 excluded 终态并跳过子流发现。
     */
    const pendingClaudeSubs = new Map<string, { claim: StreamClaim; file: VerifiedFile; discoveryLimited: boolean }>();

    for (const claim of claims.values()) {
      checkCancelled();

      // Claude 子流声明（含第二次解析时从持久 historical observation 重建的声明）
      // 统一延迟到 main 显式父子证明门控后处理。
      if (claim.client === 'claude' && claim.stream.kind === 'subagent') {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await this.verifyClaim(claim, verifyContext);
        if (outcome.discoveryLimited) markLimited();
        if (outcome.status === 'matched' && outcome.files.length === 1) {
          const file = outcome.files[0]!;
          pendingClaudeSubs.set(claim.stream.nativeAgentId, { claim, file, discoveryLimited: outcome.discoveryLimited });
        } else {
          // 无可用预核验文件：仍记录弱声明，由 resolveClaudeSubagents 有界发现裁决。
          pendingClaudeSubs.set(claim.stream.nativeAgentId, { claim, file: undefined as never, discoveryLimited: outcome.discoveryLimited });
        }
        continue;
      }

      const outcome = await this.verifyClaim(claim, verifyContext);
      if (outcome.discoveryLimited) markLimited();

      if (outcome.status === 'matched') {
        if (outcome.files.length > 1) {
          resolved.push(this.unresolvedEntry(claim, instanceId, 'ambiguous', 'ambiguous_candidates', outcome.discoveryLimited));
          continue;
        }
        const file = outcome.files[0]!;
        const keys = this.deps.createTranscriptSourceKeys(
          instanceId,
          claim.client,
          file.root.path,
          file.nativeSessionId,
          claim.stream
        );
        if (!keys) {
          resolved.push(this.unresolvedEntry(claim, instanceId, 'missing', 'native_session_id_unverified', outcome.discoveryLimited));
          continue;
        }
        if (claim.ledgerSourceKey && claim.ledgerSourceKey !== keys.sourceKey) {
          resolved.push(this.unresolvedEntry(claim, instanceId, 'ambiguous', 'source_key_conflict', outcome.discoveryLimited));
          continue;
        }
        const proofKind: ProofKind = claim.observed
          ? claim.proof
          : 'historical_verified';
        const entry: ResolvedInsightSource = {
          sourceKey: keys.sourceKey,
          sourceSessionKey: claim.ledgerSourceSessionKey ?? keys.sourceSessionKey,
          client: claim.client,
          status: 'matched',
          approvedRoot: file.root.path,
          verifiedPath: file.realPath,
          expectedNativeSessionId: file.nativeSessionId,
          expectedStream: claim.stream,
          proofKind,
          role: 'additional',
          discoveryLimited: outcome.discoveryLimited,
          relationship: file.relationship ?? NO_RELATIONSHIP,
          evidenceRefs: [...new Set(claim.evidenceRefs)],
          ...(claim.nativeContextRef ? { nativeContextRef: claim.nativeContextRef } : {}),
          isCurrentRunObserved: claim.currentRunObserved,
        };
        resolved.push(entry);
        if (claim.stream.kind === 'main') matchedMains.push(entry);
        if (claim.explicitPaths.length === 0) historicalAppends.push({ claim, file });
      } else {
        resolved.push(this.unresolvedEntry(claim, instanceId, outcome.missingStatus, outcome.reason, outcome.discoveryLimited));
      }
    }

    // ---- Claude 子 Agent：仅已核验主流范围 + 显式父子证明 ---------------
    const claudePrimaryCandidates = matchedMains.filter(entry => entry.client === 'claude');
    for (const main of claudePrimaryCandidates) {
      checkCancelled();
      // eslint-disable-next-line no-await-in-loop
      const subResult = await this.resolveClaudeSubagents(
        main, instanceId, verifyContext, resolved, pendingClaudeSubs
      );
      if (subResult.discoveryLimited) markLimited();
      // 仅追加“本次新核验、账本尚无对应 observation”的子文件 proof；
      // 第二次解析时从持久记录重建的子文件不重复追加。
      for (const item of subResult.found) {
        historicalAppends.push({
          claim: item.claim ?? this.foundClaim('claude', main.approvedRoot!, main.expectedNativeSessionId, {
            kind: 'subagent' as const,
            nativeAgentId: [...item.file.agentIds][0]!,
          }),
          file: item.file,
        });
      }
    }

    // ---- Codex / TraeX 相关线程（显式 parent 关系；不按时间补树） --------
    for (const client of ['codex', 'traex'] as const) {
      checkCancelled();
      const mains = matchedMains.filter(entry => entry.client === client);
      if (mains.length === 0) continue;
      // eslint-disable-next-line no-await-in-loop
      const relatedResult = await this.discoverCodexFamilyRelated(
        client,
        mains,
        instanceId,
        rootsByClient.get(client) ?? [],
        verifyContext,
        resolved
      );
      if (relatedResult.discoveryLimited) markLimited();
      historicalAppends.push(...relatedResult.found.map(file => ({
        claim: this.foundClaim(client, file.root.path, file.nativeSessionId, mainStream()),
        file,
      })));
    }

    // ---- 追加本次全部 historical proof（固定 revision 由 T4c 在返回后做） --
    for (const { claim, file } of historicalAppends) {
      this.appendHistoricalProof(sessionId, session.runId, instanceId, claim, file);
    }

    // ---- 角色与 primary -------------------------------------------------
    this.assignRoles(resolved, currentSelection, session.runId);
    const primarySourceKey = this.pickPrimary(resolved);

    const matchedCount = resolved.filter(source => source.status === 'matched').length;
    const inputLimit = matchedCount > SESSION_INSIGHT_LIMITS.maxSnapshotsPerJob;
    const hostOnlyReason = matchedCount === 0
      ? (resolved.some(source => source.status === 'unsupported') ? 'unsupported_driver' : 'no_verifiable_source')
      : undefined;

    return {
      sources: resolved,
      primarySourceKey,
      discoveryLimited,
      inputLimit,
      ...(hostOnlyReason ? { hostOnlyReason } : {}),
      toSafeManifestEntries(): SafeManifestEntry[] {
        return resolved.map(source => ({
          sourceKey: source.sourceKey,
          client: source.client,
          matchStatus: source.status,
          expectedStream: source.expectedStream,
          relationship: source.relationship,
          status: source.status === 'matched' ? 'ok' : 'missing',
        }));
      },
    };
  }

  // -------------------------------------------------------------------------

  private hostOnlyResult(reason: string): ResolveSessionInsightSourcesResult {
    return {
      sources: [],
      primarySourceKey: null,
      discoveryLimited: false,
      inputLimit: false,
      hostOnlyReason: reason,
      toSafeManifestEntries: () => [],
    };
  }

  private async resolveInstanceId(): Promise<string> {
    if (this.deps.instanceId && this.deps.instanceId.trim().length > 0) return this.deps.instanceId;
    const fromConfig = await this.deps.repositories.config.get(INSIGHT_INSTANCE_ID_CONFIG_KEY);
    if (fromConfig && fromConfig.trim().length > 0) return fromConfig;
    fail('INSIGHT_INSTANCE_ID_MISSING', `Stable config ${INSIGHT_INSTANCE_ID_CONFIG_KEY} is not set`);
  }

  private foundClaim(
    client: InsightClient,
    canonicalRoot: string,
    nativeSessionId: string,
    stream: StreamIdentity
  ): StreamClaim {
    return {
      correlation: stableCorrelation(client, canonicalRoot, nativeSessionId, stream),
      client,
      canonicalRoot,
      stream,
      nativeSessionId,
      explicitPaths: [],
      roots: [{ path: canonicalRoot, client }],
      observed: false,
      proof: 'historical_verified',
      currentRunObserved: false,
      evidenceRefs: [],
    };
  }

  private unresolvedEntry(
    claim: StreamClaim,
    instanceId: string,
    status: SourceMatchStatus,
    reason: string | undefined,
    discoveryLimited: boolean
  ): ResolvedInsightSource {
    let sourceKey = claim.ledgerSourceKey;
    let sourceSessionKey = claim.ledgerSourceSessionKey;
    if (!sourceKey && claim.nativeSessionId && claim.roots[0]) {
      const keys = this.deps.createTranscriptSourceKeys(
        instanceId,
        claim.client,
        claim.roots[0].path,
        claim.nativeSessionId,
        claim.stream
      );
      if (keys) {
        sourceKey = keys.sourceKey;
        sourceSessionKey = keys.sourceSessionKey;
      }
    }
    return {
      sourceKey: sourceKey ?? `unresolved:${sha256Hex(claim.correlation)}`,
      ...(sourceSessionKey ? { sourceSessionKey } : {}),
      client: claim.client,
      status,
      expectedNativeSessionId: claim.nativeSessionId ?? '',
      expectedStream: claim.stream,
      proofKind: claim.proof,
      role: 'excluded',
      discoveryLimited,
      ...(reason ? { reason } : {}),
      relationship: NO_RELATIONSHIP,
      evidenceRefs: claim.evidenceRefs,
      ...(claim.nativeContextRef ? { nativeContextRef: claim.nativeContextRef } : {}),
    };
  }

  private collectCheckpointClaims(
    attempt: TaskAttempt,
    agentClient: InsightClient | undefined,
    getClaim: (
      client: InsightClient,
      canonicalRoot: string | undefined,
      nativeSessionId: string | undefined,
      stream: StreamIdentity
    ) => StreamClaim,
    strengthen: (claim: StreamClaim, proof: ProofKind) => void
  ): void {
    if (!agentClient) return;
    for (const recovered of attempt.recoveryControllers) {
      const evidence = recovered.evidence;
      if (evidence.kind !== 'original_turn') continue;
      const checkpointPath = evidence.recovery?.transcript?.path;
      if (typeof checkpointPath !== 'string' || checkpointPath.length === 0) continue;
      const claim = getClaim(agentClient, undefined, undefined, mainStream());
      if (!claim.explicitPaths.includes(checkpointPath)) claim.explicitPaths.push(checkpointPath);
      strengthen(claim, 'historical_verified');
      claim.evidenceRefs.push(`attempt:${attempt.attemptId}:checkpoint`);
    }
  }

  private async verifyClaim(
    claim: StreamClaim,
    ctx: VerifyContext
  ): Promise<
    | { status: 'matched'; files: VerifiedFile[]; discoveryLimited: boolean }
    | {
        status: 'missing' | 'ambiguous';
        missingStatus: SourceMatchStatus;
        reason?: string;
        discoveryLimited: boolean;
      }
  > {
    // 显式路径不受目录限额影响，直查对应文件
    if (claim.explicitPaths.length > 0) {
      const verified: VerifiedFile[] = [];
      const seenPaths = new Set<string>();
      const rejections = new Set<string>();
      for (const rawPath of claim.explicitPaths) {
        ctx.checkCancelled();
        // eslint-disable-next-line no-await-in-loop
        const result = await this.verifyExplicitPath(rawPath, claim, ctx);
        if (result.status === 'verified') {
          if (seenPaths.has(result.file.realPath)) continue;
          seenPaths.add(result.file.realPath);
          verified.push(result.file);
        } else {
          rejections.add(result.reason);
        }
      }
      if (verified.length === 1) return { status: 'matched', files: verified, discoveryLimited: false };
      if (verified.length > 1) return { status: 'ambiguous', missingStatus: 'ambiguous', reason: 'ambiguous_explicit_candidates', discoveryLimited: false };
      return {
        status: 'missing',
        missingStatus: 'missing',
        reason: [...rejections].join(','),
        discoveryLimited: false,
      };
    }

    if (!claim.nativeSessionId) {
      if (claim.markerDiscovery) {
        const discovered = await this.discoverByIdentity(claim, ctx);
        // 关键红线：如果扫描未穷尽（limited === true），无法证明候选唯一性，不得假唯一绑定！
        if (discovered.truncatedAmbiguous || discovered.files.length > 1) {
          return {
            status: 'ambiguous',
            missingStatus: 'ambiguous',
            reason: discovered.truncatedAmbiguous ? 'truncated_marker_unverified_uniqueness' : 'ambiguous_candidates',
            discoveryLimited: discovered.limited,
          };
        }
        if (discovered.files.length === 1 && !discovered.limited) {
          return { status: 'matched', files: discovered.files, discoveryLimited: false };
        }
        return {
          status: 'missing',
          missingStatus: 'missing',
          reason: discovered.limited ? 'no_match_discovery_limited' : 'no_matching_candidate',
          discoveryLimited: discovered.limited,
        };
      }
      return { status: 'missing', missingStatus: 'missing', reason: 'native_session_id_unverified', discoveryLimited: false };
    }

    const discovered = await this.discoverByIdentity(claim, ctx);
    // 唯一性未被完整证实（截断）时绝不假唯一：返回 ambiguous + limited，不取 latest。
    if (discovered.truncatedAmbiguous) {
      return {
        status: 'ambiguous',
        missingStatus: 'ambiguous',
        reason: 'truncated_discovery_unverified_uniqueness',
        discoveryLimited: true,
      };
    }
    if (discovered.files.length > 1) {
      return { status: 'ambiguous', missingStatus: 'ambiguous', reason: 'ambiguous_candidates', discoveryLimited: discovered.limited };
    }
    if (discovered.files.length === 1) {
      return { status: 'matched', files: discovered.files, discoveryLimited: discovered.limited };
    }
    return {
      status: 'missing',
      missingStatus: 'missing',
      reason: discovered.limited ? 'no_match_discovery_limited' : 'no_matching_candidate',
      discoveryLimited: discovered.limited,
    };
  }

  private async verifyExplicitPath(
    rawPath: string,
    claim: StreamClaim,
    ctx: VerifyContext
  ): Promise<{ status: 'verified'; file: VerifiedFile } | { status: 'rejected'; reason: string }> {
    ctx.checkCancelled();
    const reject = (reason: string) => ({ status: 'rejected' as const, reason });
    const real = await canonicalRealPath(rawPath);
    if (!real) return reject('path_unresolvable');
    const root = claim.roots.find(candidate => isWithinRoot(real, candidate.path));
    if (!root) return reject('path_outside_approved_root');
    try {
      const st = await lstat(real);
      if (!st.isFile()) return reject('not_regular_file');
    } catch {
      return reject('path_unresolvable');
    }
    const head = await this.readIdentityHead(real, claim, ctx);
    if (!head) return reject('content_unreadable');
    const identity = claim.client === 'claude'
      ? extractClaudeIdentity(head)
      : extractCodexFamilyIdentity(head);
    if (identity.conflictingSessionIds) return reject('content_session_id_conflict');
    if (!identity.nativeSessionId) return reject('content_native_id_missing');
    if (claim.nativeSessionId && identity.nativeSessionId !== claim.nativeSessionId) {
      return reject('content_native_id_mismatch');
    }
    if (identity.cwd && ctx.sessionCwd) {
      const contentCwd = (await canonicalRealPath(identity.cwd)) ?? resolve(identity.cwd);
      if (contentCwd !== ctx.sessionCwd) return reject('content_cwd_mismatch');
    }
    if (claim.client === 'claude') {
      if (claim.stream.kind === 'subagent') {
        if (!identity.sidechain || identity.agentIds.size !== 1
          || !identity.agentIds.has(claim.stream.nativeAgentId)) {
          return reject('subagent_identity_mismatch');
        }
      } else {
        if (identity.sidechain) return reject('main_stream_cannot_be_sidechain');
      }
    }
    return {
      status: 'verified',
      file: {
        realPath: real,
        root,
        nativeSessionId: identity.nativeSessionId,
        ...(identity.cwd ? { cwd: identity.cwd } : {}),
        agentIds: identity.agentIds,
        sidechain: identity.sidechain,
        ...(identity.relationship ? { relationship: identity.relationship } : {}),
      },
    };
  }

  private async readIdentityHead(
    realPath: string,
    claim: StreamClaim,
    ctx: VerifyContext
  ): Promise<Array<{ line: number; value: any }> | undefined> {
    void claim;
    const raw = await readHeadBytes(realPath, this.limits.identityHeadBytes, ctx.onIdentityRead, ctx.checkCancelled);
    if (!raw) return undefined;
    const prefix = completeLinePrefix(raw);
    const lines = parseJsonlBuffer(prefix);
    return lines.length > 0 ? lines : undefined;
  }

  private async inspectCandidate(
    rawPath: string,
    root: RootSet,
    claim: StreamClaim,
    ctx: VerifyContext,
    marker: string
  ): Promise<{ realPath: string; identity: JsonIdentity; markerMatch: boolean } | undefined> {
    const real = await canonicalRealPath(rawPath);
    if (!real || !isWithinRoot(real, root.path)) return undefined;
    try {
      const st = await lstat(real);
      if (!st.isFile()) return undefined;
    } catch {
      return undefined;
    }
    const raw2 = await readHeadBytes(real, this.limits.identityHeadBytes, ctx.onIdentityRead, ctx.checkCancelled);
    if (!raw2) return undefined;
    const prefix = completeLinePrefix(raw2);
    const text = prefix.toString('utf8');
    const lines = parseJsonlBuffer(prefix);
    if (lines.length === 0) return undefined;
    const identity = claim.client === 'claude'
      ? extractClaudeIdentity(lines)
      : extractCodexFamilyIdentity(lines);
    if (identity.conflictingSessionIds) return undefined;
    if (identity.cwd && ctx.sessionCwd) {
      const contentCwd = (await canonicalRealPath(identity.cwd)) ?? resolve(identity.cwd);
      if (contentCwd !== ctx.sessionCwd) return undefined;
    }
    const markerMatch = text.includes(marker);
    return { realPath: real, identity, markerMatch };
  }

  /**
   * 在核准根内按已知 native id（或 marker）有界发现候选。
   */
  private async discoverByIdentity(
    claim: StreamClaim,
    ctx: VerifyContext
  ): Promise<{ files: VerifiedFile[]; limited: boolean; truncatedAmbiguous?: boolean }> {
    const out: VerifiedFile[] = [];
    const seenPaths = new Set<string>();
    let limited = false;
    let remainingScans = this.limits.maxContentScansPerGroup;
    const marker = buildSessionMarker(ctx.sessionId);

    for (const root of claim.roots) {
      ctx.checkCancelled();
      // eslint-disable-next-line no-await-in-loop
      const candidates = await this.enumerateRootCandidates(root, ctx);
      if (candidates.limited) limited = true;
      candidates.files.sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const candidate of candidates.files) {
        ctx.checkCancelled();
        if (remainingScans <= 0) {
          limited = true;
          break;
        }
        remainingScans -= 1;
        // eslint-disable-next-line no-await-in-loop
        const inspected = await this.inspectCandidate(candidate.path, root, claim, ctx, marker);
        if (!inspected) continue;

        if (claim.nativeSessionId) {
          if (inspected.identity.nativeSessionId !== claim.nativeSessionId) continue;
        } else {
          // marker 发现：必须 marker 命中且内容读出了有效原生 ID
          if (!inspected.markerMatch || !inspected.identity.nativeSessionId) continue;
        }

        if (claim.stream.kind === 'main' && inspected.identity.sidechain) continue;
        if (claim.stream.kind === 'subagent'
          && (!inspected.identity.sidechain || inspected.identity.agentIds.size !== 1
            || !inspected.identity.agentIds.has(claim.stream.nativeAgentId))) {
          continue;
        }
        if (seenPaths.has(inspected.realPath)) continue;
        seenPaths.add(inspected.realPath);
        out.push({
          realPath: inspected.realPath,
          root,
          nativeSessionId: inspected.identity.nativeSessionId,
          ...(inspected.identity.cwd ? { cwd: inspected.identity.cwd } : {}),
          agentIds: inspected.identity.agentIds,
          sidechain: inspected.identity.sidechain,
          ...(inspected.identity.relationship ? { relationship: inspected.identity.relationship } : {}),
        });
      }
      if (remainingScans <= 0) break;
    }

    // 截断（limited）且尚未完整排除同 ID 冲突文件时，任何发现都不能被当作唯一绑定。
    // - 无先验 native ID（markerDiscovery）：即便扫到 1 个也必须保守不匹配；
    // - 有明确 native ID：唯一性未经证实，同样不能选 latest 强绑。
    if (limited && out.length >= 1) {
      return { files: out, limited: true, truncatedAmbiguous: true };
    }

    return { files: out, limited };
  }

  private async enumerateRootCandidates(
    root: RootSet,
    ctx: VerifyContext
  ): Promise<{ files: Array<{ path: string; mtimeMs: number }>; limited: boolean }> {
    if (root.client === 'claude') {
      if (!ctx.claudeProjectKey) return { files: [], limited: false };
      const projectDir = join(root.path, 'projects', ctx.claudeProjectKey);
      return walkCandidates(
        projectDir,
        name => name.endsWith('.jsonl'),
        0,
        ctx
      );
    }
    const sessionsDir = root.client === 'traex'
      ? join(root.path, 'cli', 'sessions')
      : join(root.path, 'sessions');
    return walkCandidates(
      sessionsDir,
      name => name.startsWith('rollout-') && name.endsWith('.jsonl'),
      3,
      ctx
    );
  }

  /**
   * Claude 子 Agent 解析：
   * 1. 主流必须给出 Agent tool_use 与 tool_result 的 toolUseResult.agentId 显式证明；
   * 2. 扫描 Claude 2.1.288 真实原生布局：
   *    projects/<projectKey>/<nativeSessionId>/subagents/agent-<agentId>.jsonl
   *    以及 flat 布局 projects/<projectKey>/<agentId>.jsonl；
   * 3. 必须内容中 nativeSessionId === main.expectedNativeSessionId 且 isSidechain=true；
   * 4. 同一 agentId 存在多个候选文件时返回 ambiguous。
   */
  private async resolveClaudeSubagents(
    main: ResolvedInsightSource,
    instanceId: string,
    ctx: VerifyContext,
    resolved: ResolvedInsightSource[],
    pending: Map<string, { claim: StreamClaim; file?: VerifiedFile; discoveryLimited: boolean }>
  ): Promise<{
    discoveryLimited: boolean;
    found: Array<{ file: VerifiedFile; claim?: StreamClaim }>;
  }> {
    let discoveryLimited = false;
    const found: Array<{ file: VerifiedFile; claim?: StreamClaim }> = [];
    const raw = await readHeadBytes(main.verifiedPath!, this.limits.proofScanBytes, ctx.onIdentityRead, ctx.checkCancelled);
    if (!raw) return { discoveryLimited: false, found };
    const lines = parseJsonlBuffer(completeLinePrefix(raw));

    const calls = new Map<string, number>();
    const proofs = new Map<string, { callId: string; callLine: number; resultLine: number }>();
    for (const { line, value } of lines) {
      const blocks = Array.isArray(value?.message?.content) ? value.message.content : [];
      if (value?.type === 'assistant') {
        for (const block of blocks) {
          if (block?.type === 'tool_use' && block.name === 'Agent' && typeof block.id === 'string') {
            calls.set(block.id, line);
          }
        }
      } else if (value?.type === 'user') {
        for (const block of blocks) {
          if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
          const callLine = calls.get(block.tool_use_id);
          const resultAgentId = value.toolUseResult?.agentId;
          if (callLine !== undefined && typeof resultAgentId === 'string' && resultAgentId.length > 0) {
            proofs.set(resultAgentId, { callId: block.tool_use_id, callLine, resultLine: line });
          }
        }
      }
    }
    if (proofs.size === 0) return { discoveryLimited: false, found };

    const projectDir = join(main.approvedRoot!, 'projects', this.projectKeyOf(main));
    const nestedSubagentsDir = join(projectDir, main.expectedNativeSessionId, 'subagents');

    const walkNested = await walkCandidates(
      nestedSubagentsDir,
      name => name.endsWith('.jsonl'),
      0,
      ctx
    );
    const walkFlat = await walkCandidates(
      projectDir,
      name => name.endsWith('.jsonl'),
      0,
      ctx
    );
    if (walkNested.limited || walkFlat.limited) discoveryLimited = true;

    const allCandidates = [...walkNested.files, ...walkFlat.files];
    allCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    let scans = this.limits.maxContentScansPerGroup;
    // agentId -> 本次有界发现核验的候选文件
    const filesByAgent = new Map<string, VerifiedFile[]>();
    for (const candidate of allCandidates) {
      ctx.checkCancelled();
      if (scans <= 0) {
        discoveryLimited = true;
        break;
      }
      scans -= 1;
      const real = await canonicalRealPath(candidate.path);
      if (!real || real === main.verifiedPath) continue;
      if (!isWithinRoot(real, main.approvedRoot!)) continue;
      // eslint-disable-next-line no-await-in-loop
      const head = await readHeadBytes(real, this.limits.identityHeadBytes, ctx.onIdentityRead, ctx.checkCancelled);
      if (!head) continue;
      const identity = extractClaudeIdentity(parseJsonlBuffer(completeLinePrefix(head)));
      if (identity.conflictingSessionIds) continue;
      if (identity.nativeSessionId !== main.expectedNativeSessionId) continue;
      if (!identity.sidechain || identity.agentIds.size !== 1) continue;
      const [agentId] = [...identity.agentIds];
      if (!agentId || !proofs.has(agentId)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const st = await lstat(real);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      const file: VerifiedFile = {
        realPath: real,
        root: { path: main.approvedRoot!, client: 'claude' },
        nativeSessionId: identity.nativeSessionId!,
        agentIds: identity.agentIds,
        sidechain: true,
      };
      const list = filesByAgent.get(agentId) ?? [];
      if (!list.some(item => item.realPath === real)) list.push(file);
      filesByAgent.set(agentId, list);
    }

    for (const [agentId, proof] of proofs) {
      const stream: StreamIdentity = { kind: 'subagent', nativeAgentId: agentId };
      const keys = this.deps.createTranscriptSourceKeys(
        instanceId,
        'claude',
        main.approvedRoot!,
        main.expectedNativeSessionId,
        stream
      );
      if (!keys) continue;
      const relationship: FileRelationship = {
        kind: 'child',
        parentNativeSessionId: main.expectedNativeSessionId,
        parentNativeAgentId: null,
        evidenceRefs: [
          `main:L${proof.callLine}:tool_use:Agent:${proof.callId}`,
          `main:L${proof.resultLine}:tool_result:agentId:${agentId}`,
          `subagent:L*:agentId:${agentId}`,
        ],
      };
      const base: ResolvedInsightSource = {
        sourceKey: keys.sourceKey,
        sourceSessionKey: keys.sourceSessionKey,
        client: 'claude',
        status: 'missing',
        expectedNativeSessionId: main.expectedNativeSessionId,
        expectedStream: stream,
        proofKind: 'historical_verified',
        role: 'subagent',
        discoveryLimited,
        relationship,
        evidenceRefs: relationship.evidenceRefs,
      };

      // 合并候选：本次有界发现文件 + 第二次解析时从持久 observation 预核验的文件。
      const persisted = pending.get(agentId);
      if (persisted?.discoveryLimited) discoveryLimited = true;
      const merged: VerifiedFile[] = [...(filesByAgent.get(agentId) ?? [])];
      if (persisted?.file && !merged.some(item => item.realPath === persisted.file!.realPath)) {
        // 持久记录文件仍须属于本 main（sessionId / sidechain / agentId 已在主循环
        // 按 stream 身份核验过），且显式 parent proof 刚刚成立，这里只做 parent 归属复核。
        if (persisted.file.nativeSessionId === main.expectedNativeSessionId) {
          merged.push(persisted.file);
        }
      }

      if (merged.length === 1) {
        const file = merged[0]!;
        // 持久 observation 已存在该文件时回传其 claim（不重复 append proof）；
        // 否则作为本次新核验发现返回，由调用方追加 historical proof。
        const isPersisted = persisted?.file?.realPath === file.realPath;
        found.push({ file, ...(isPersisted && persisted!.claim.observed ? { claim: persisted!.claim } : {}) });
        resolved.push({
          ...base,
          status: 'matched',
          approvedRoot: main.approvedRoot,
          verifiedPath: file.realPath,
        });
      } else if (merged.length > 1) {
        resolved.push({ ...base, status: 'ambiguous', discoveryLimited: true, reason: 'ambiguous_subagent_candidates' });
      } else {
        resolved.push({ ...base, reason: discoveryLimited ? 'subagent_discovery_limited' : 'subagent_file_missing' });
      }
    }
    return { discoveryLimited, found };
  }

  private projectKeyOf(main: ResolvedInsightSource): string {
    const parts = main.verifiedPath!.split(sep);
    const projectsIndex = parts.lastIndexOf('projects');
    if (projectsIndex >= 0 && parts[projectsIndex + 1]) return parts[projectsIndex + 1]!;
    return main.expectedNativeSessionId.replace(/[^A-Za-z0-9-]/g, '-');
  }

  private async discoverCodexFamilyRelated(
    client: InsightClient,
    mains: ResolvedInsightSource[],
    instanceId: string,
    roots: RootSet[],
    ctx: VerifyContext,
    resolved: ResolvedInsightSource[]
  ): Promise<{ discoveryLimited: boolean; found: VerifiedFile[] }> {
    let discoveryLimited = false;
    const found: VerifiedFile[] = [];
    const mainIds = new Set(mains.map(main => main.expectedNativeSessionId));
    let scans = this.limits.maxContentScansPerGroup;
    const groups = new Map<string, { file: VerifiedFile; root: RootSet; relationship: FileRelationship }[]>();

    for (const root of roots) {
      ctx.checkCancelled();
      // eslint-disable-next-line no-await-in-loop
      const walk = await this.enumerateRootCandidates(
        { path: root.path, client },
        ctx
      );
      if (walk.limited) discoveryLimited = true;
      walk.files.sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const candidate of walk.files) {
        ctx.checkCancelled();
        if (scans <= 0) return { discoveryLimited: true, found };
        scans -= 1;
        const real = await canonicalRealPath(candidate.path);
        if (!real) continue;
        if (mains.some(main => main.verifiedPath === real)) continue;
        if (resolved.some(source => source.verifiedPath === real)) continue;
        if (!isWithinRoot(real, root.path)) continue;
        // eslint-disable-next-line no-await-in-loop
        const head = await readHeadBytes(real, this.limits.identityHeadBytes, ctx.onIdentityRead, ctx.checkCancelled);
        if (!head) continue;
        const identity = extractCodexFamilyIdentity(parseJsonlBuffer(completeLinePrefix(head)));
        if (identity.conflictingSessionIds) continue;
        if (!identity.nativeSessionId || !identity.relationship) continue;
        const parentId = identity.relationship.parentNativeSessionId;
        if (!parentId || !mainIds.has(parentId)) continue;
        if (identity.cwd && ctx.sessionCwd) {
          // eslint-disable-next-line no-await-in-loop
          const contentCwd = (await canonicalRealPath(identity.cwd)) ?? resolve(identity.cwd);
          if (contentCwd !== ctx.sessionCwd) continue;
        }
        if (mains.some(main => main.expectedNativeSessionId === identity.nativeSessionId)) continue;
        const file: VerifiedFile = {
          realPath: real,
          root,
          nativeSessionId: identity.nativeSessionId,
          ...(identity.cwd ? { cwd: identity.cwd } : {}),
          agentIds: new Set(),
          sidechain: false,
          relationship: identity.relationship,
        };
        const group = groups.get(identity.nativeSessionId) ?? [];
        if (!group.some(item => item.file.realPath === real)) {
          group.push({ file, root, relationship: identity.relationship });
          groups.set(identity.nativeSessionId, group);
        }
      }
    }

    for (const [nativeSessionId, group] of groups) {
      const keys = this.deps.createTranscriptSourceKeys(
        instanceId,
        client,
        group[0]!.root.path,
        nativeSessionId,
        mainStream()
      );
      if (!keys) continue;
      const relationship = group[0]!.relationship;
      if (group.length === 1) {
        const { file, root } = group[0]!;
        found.push(file);
        resolved.push({
          sourceKey: keys.sourceKey,
          sourceSessionKey: keys.sourceSessionKey,
          client,
          status: 'matched',
          approvedRoot: root.path,
          verifiedPath: file.realPath,
          expectedNativeSessionId: nativeSessionId,
          expectedStream: mainStream(),
          proofKind: 'historical_verified',
          role: 'additional',
          discoveryLimited: false,
          relationship,
          evidenceRefs: relationship.evidenceRefs,
        });
      } else {
        resolved.push({
          sourceKey: keys.sourceKey,
          sourceSessionKey: keys.sourceSessionKey,
          client,
          status: 'ambiguous',
          expectedNativeSessionId: nativeSessionId,
          expectedStream: mainStream(),
          proofKind: 'historical_verified',
          role: 'excluded',
          discoveryLimited: true,
          reason: 'ambiguous_related_candidates',
          relationship,
          evidenceRefs: relationship.evidenceRefs,
        });
      }
    }
    return { discoveryLimited, found };
  }

  private appendHistoricalProof(
    sessionId: string,
    runId: string,
    instanceId: string,
    claim: StreamClaim,
    file: VerifiedFile
  ): void {
    const observationId = `hist_${sha256Hex(JSON.stringify([
      sessionId,
      claim.client,
      file.root.path,
      file.nativeSessionId,
      streamLabel(claim.stream),
      claim.stream.kind === 'subagent' ? claim.stream.nativeAgentId : null,
      file.realPath,
    ]))}`;
    const existing = this.deps.repositories.insight.listSources(sessionId);
    if (existing.some(obs => obs.observationId === observationId)) return;

    const keys = this.deps.createTranscriptSourceKeys(
      instanceId,
      claim.client,
      file.root.path,
      file.nativeSessionId,
      claim.stream
    );
    const observation: TranscriptSourceObservation = {
      observationId,
      sessionId,
      activeRunId: runId,
      driverInstanceId: 'historical-resolver',
      client: claim.client,
      launchKind: 'attached',
      proofKind: 'historical_verified',
      capturedAt: new Date().toISOString(),
      dataRoot: file.root.path,
      ...(file.cwd ? { cwd: file.cwd } : { cwd: null }),
      nativeSessionId: file.nativeSessionId,
      verifiedPath: file.realPath,
      identityProof: `content_native_id:${file.nativeSessionId}`,
      sourceSessionKey: keys?.sourceSessionKey ?? null,
      streamIdentity: claim.stream,
      sourceKey: keys?.sourceKey ?? null,
      ...(claim.nativeContextRef ? { nativeContextRef: claim.nativeContextRef } : {}),
    };
    this.deps.repositories.insight.appendHistoricalProof(observation);
  }

  /**
   * 角色分配与 primary 判定：
   *  1. matched main 中携带当前 active run 的 native selection 引用的来源；
   *  2. 当前 active run 且由当前活动 driver 权威观察的 launch_observed main；
   *  3. 历史 run 的 launch_observed 属于历史来源，保持 additional，不能被误升为 primary；
   *  4. 若有且仅有一个 matched main，它成为 primary；若存在多个不同历史 main 无法定权威，
   *     则 primarySourceKey = null，各 main 均保持 additional，不按 mtime 随意猜测。
   */
  private assignRoles(
    resolved: ResolvedInsightSource[],
    currentSelection: NativeContextRef | undefined,
    currentRunId: string
  ): void {
    void currentRunId;
    for (const source of resolved) {
      if (source.role === 'subagent') continue;
      source.role = source.status === 'matched' && source.expectedStream.kind === 'main'
        ? 'additional'
        : 'excluded';
    }
    const matchedMains = resolved.filter(
      source => source.status === 'matched' && source.expectedStream.kind === 'main'
    );
    let primary: ResolvedInsightSource | undefined;
    if (currentSelection) {
      primary = matchedMains.find(
        main => main.nativeContextRef && JSON.stringify(main.nativeContextRef) === JSON.stringify(currentSelection)
      );
    }
    if (!primary) {
      const currentObserved = matchedMains.filter(main => main.isCurrentRunObserved);
      if (currentObserved.length === 1) {
        primary = currentObserved[0];
      } else if (currentObserved.length === 0 && matchedMains.length === 1) {
        primary = matchedMains[0];
      }
    }
    if (primary) primary.role = 'primary';
  }

  private pickPrimary(resolved: ResolvedInsightSource[]): string | null {
    const primary = resolved.find(source => source.role === 'primary' && source.status === 'matched');
    return primary?.sourceKey ?? null;
  }
}

// ---------------------------------------------------------------------------
// 顶层便捷函数
// ---------------------------------------------------------------------------

export async function resolveSessionInsightSources(
  sessionId: string,
  deps: SessionInsightResolverDependencies,
  options?: ResolveSessionInsightSourcesOptions
): Promise<ResolveSessionInsightSourcesResult> {
  return new SessionInsightResolver(deps).resolveSessionInsightSources(sessionId, options);
}

export type { DriverResource };
