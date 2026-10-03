import { createHash } from 'node:crypto';
import { realpath as nodeRealpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  InsightClient,
  StreamIdentity
} from '@dutydeck/shared';

export const INSIGHT_INSTANCE_ID_CONFIG_KEY = 'insight.instance_id';

/**
 * 可注入的 realpath 接缝，仅供测试挂起/控制 dataRoot 规范化时序（in-flight stale race）。
 * 生产使用 node:fs/promises.realpath；传 null 还原。
 */
export let realpathImpl: (path: string) => Promise<string> = nodeRealpath;

export function __setRealpathImplForTest(impl: ((path: string) => Promise<string>) | null): void {
  realpathImpl = impl ?? nodeRealpath;
}

/**
 * 规范化数据根目录（解析真实符号链接），用于稳定的 source key 计算。
 * 必须在写队列之外异步完成；失败回退 lexical resolve（仅用于保留 launch 缺目录观察，
 * 该 fallback 绝不被 resolver 当作已核验 path）。
 */
export async function canonicalizeDataRoot(dataRoot: string): Promise<string> {
  const resolved = resolve(dataRoot);
  try {
    return await realpathImpl(resolved);
  } catch {
    return resolved;
  }
}

/**
 * 根据设计 3.1 计算稳定的 sourceSessionKey 和 sourceKey（均为 SHA256 hex，路径不参与 sourceKey 输入之外的易变值）：
 *   sourceSessionKey = SHA256(JSON.stringify(['session-insight-v1', instanceId, client, canonicalDataRoot, nativeSessionId]))
 *   sourceKey        = SHA256(JSON.stringify([sourceSessionKey, streamIdentity.kind, streamIdentity.nativeAgentId]))
 * 当且仅当 nativeSessionId 为非空字符串（完整原生身份存在）时计算；否则返回 null，
 * 未绑定记录不参与解析请求。main 流的 nativeAgentId 严格为 null。
 */
export function createTranscriptSourceKeys(
  instanceId: string,
  client: InsightClient,
  canonicalDataRoot: string,
  nativeSessionId: string | null | undefined,
  streamIdentity?: StreamIdentity
): { sourceSessionKey: string; sourceKey: string } | null {
  if (!nativeSessionId || nativeSessionId.trim() === '') {
    return null;
  }
  const stream: StreamIdentity = streamIdentity?.kind === 'subagent'
    ? { kind: 'subagent', nativeAgentId: streamIdentity.nativeAgentId }
    : { kind: 'main', nativeAgentId: null };

  const sessionPayload = JSON.stringify([
    'session-insight-v1',
    instanceId,
    client,
    canonicalDataRoot,
    nativeSessionId
  ]);
  const sourceSessionKey = createHash('sha256').update(sessionPayload, 'utf8').digest('hex');

  const sourcePayload = JSON.stringify([
    sourceSessionKey,
    stream.kind,
    stream.nativeAgentId
  ]);
  const sourceKey = createHash('sha256').update(sourcePayload, 'utf8').digest('hex');

  return { sourceSessionKey, sourceKey };
}
