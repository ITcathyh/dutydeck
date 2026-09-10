import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RelayError, type RelayCapability, type RelaySecretStore, type RelaySessionLookup } from './types.js';

/** relay 签名密钥在 config 表里的键名 */
export const relaySigningSecretConfigKey = 'relay.signing_secret';

/** 注入子进程的环境变量名。小写 snake_case 是 ACPX 持久化键名约束（见 CLAUDE.md）。 */
export const relayUrlEnvKey = 'dutydeck_relay_url';
export const relayTokenEnvKey = 'dutydeck_relay_token';
/** 运行期算出的 dutydeck 调用前缀（`'<node>' '<abs>/cli.js'`），解决静态文案拿不到绝对路径的问题 */
export const relayCommandEnvKey = 'dutydeck_relay_command';

/** 会话进入这些状态后凭证立即失效 */
const terminalStates = new Set(['failed', 'stopped']);

export async function loadOrCreateRelaySigningSecret(store: RelaySecretStore) {
  const existing = (await store.get(relaySigningSecretConfigKey))?.trim();
  if (existing) return existing;
  const created = randomBytes(32).toString('base64url');
  await store.set(relaySigningSecretConfigKey, created);
  return created;
}

/** 定长比较，避免按字符早退泄漏前缀信息 */
function tokensEqual(left: string, right: string) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 会话能力凭证登记处。
 *
 * 鉴权设计：token = HMAC(secret, "dutydeck-relay-v1\0<sessionId>")，`v1.` 前缀便于将来轮换算法。
 *
 *  - **确定性**：同一会话在 daemon 重启后仍得到同一 token（secret 持久化在 config 表），
 *    所以「进程重启 → 子进程手里的旧 token 立刻失效」这种伪故障不会发生。
 *  - **会话即身份**：sessionId 是从 token 反解出来的，调用方无法自报 sessionId。
 *    这正是「CLI 子进程不能冒充别的会话」的实现点——见 resolve()，
 *    路由层任何来自 body/query 的 sessionId 都只能用来做一致性校验，不能用来选会话。
 *  - **可反算**：与 lark 的 registry 不同，这里 resolve 时**重算 HMAC**而不是查内存表。
 *    lark 版依赖 environmentFor() 先把 token 塞进 Map，daemon 重启后旧 token 直接 401；
 *    relay 走重算，重启后仍然可用（PTY 子进程可能比 daemon 活得久）。
 */
export class RelayCapabilityRegistry {
  constructor(
    private readonly sessions: RelaySessionLookup,
    private readonly apiBaseUrl: string,
    private readonly signingSecret: string,
    private readonly commandPrefix?: string
  ) {}

  tokenFor(sessionId: string) {
    const digest = this.digestFor(sessionId);
    // sessionId 编进 token 本身：服务端从 token 反解会话，而不是听调用方自报。
    return `v1.${Buffer.from(sessionId, 'utf8').toString('base64url')}.${digest}`;
  }

  private digestFor(sessionId: string) {
    return createHmac('sha256', this.signingSecret)
      .update(`dutydeck-relay-v1\0${sessionId}`)
      .digest('base64url');
  }

  /**
   * 注入子进程的环境变量。**任何会话都返回**（不像 lark 版要求先有飞书绑定），
   * 因此 Web 与飞书创建的 pty-cli 会话都具备同一套回传能力。
   */
  environmentFor(sessionId: string): Record<string, string> {
    return {
      [relayUrlEnvKey]: `${this.apiBaseUrl.replace(/\/$/, '')}/api/relay`,
      [relayTokenEnvKey]: this.tokenFor(sessionId),
      ...(this.commandPrefix ? { [relayCommandEnvKey]: this.commandPrefix } : {})
    };
  }

  /**
   * 从 token 反解会话，并校验会话仍可接收消息。失败一律抛 RelayError。
   *
   * `expectedSessionId` 只用于**额外收紧**：路径里带了会话 id 时必须与 token 内的一致，
   * 但会话身份始终以 token 为准——调用方自报的 id 永远不能扩大它的权限。
   */
  async resolve(token: string | undefined, expectedSessionId?: string): Promise<RelayCapability> {
    const presented = token?.trim();
    if (!presented) {
      throw new RelayError('RELAY_CONTEXT_REQUIRED', '回传通道只能由 Dutydeck 会话内的 Agent 调用；当前进程没有会话凭证。', 401);
    }
    const parts = presented.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) {
      throw new RelayError('RELAY_UNAUTHORIZED', '回传凭证格式无效。', 401);
    }
    let sessionId: string;
    try { sessionId = Buffer.from(parts[1], 'base64url').toString('utf8'); }
    catch { throw new RelayError('RELAY_UNAUTHORIZED', '回传凭证格式无效。', 401); }
    if (!sessionId) throw new RelayError('RELAY_UNAUTHORIZED', '回传凭证格式无效。', 401);
    // 先验签：签名不过一律 401，不泄漏该会话是否存在
    if (!tokensEqual(presented, this.tokenFor(sessionId))) {
      throw new RelayError('RELAY_UNAUTHORIZED', '回传凭证无效，或不属于该会话。', 401);
    }
    if (expectedSessionId && expectedSessionId !== 'self' && expectedSessionId !== sessionId) {
      throw new RelayError('RELAY_UNAUTHORIZED', '回传凭证不属于该会话。', 401);
    }
    const session = await this.sessions.get(sessionId);
    if (!session || session.archivedAt || terminalStates.has(session.state)) {
      throw new RelayError('RELAY_SESSION_ENDED', '会话已结束，回传凭证不再有效。', 401);
    }
    return { sessionId, token: presented };
  }
}

/** 从 `Authorization: Bearer <token>` 取 token */
export const relayBearerToken = (authorization?: string) => {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
};
