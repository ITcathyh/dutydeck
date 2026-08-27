/**
 * Owner-identity boundary for Lark bot configuration.
 *
 * An `ou_` open_id is app-scoped: it is meaningful only to the app that issued
 * or observed it. Copying an ou_ from bot A's saved config into bot B's
 * allowedUsers (e.g. via the Dashboard/API "duplicate bot" flow, or any caller
 * that writes raw `allowedUsers` instead of resolving names through the target
 * app) locks every owner out of B — B can never resolve A's open_id, and a
 * whitelist containing only foreign ou_ matches nobody. This module validates
 * raw owner entries through the TARGET app before they are persisted:
 *
 * - Definitive misses are rejected: cross-app open_id (99992361), target-app
 *   invalid ids (41012 / 40001), and clean code:0 responses without a user.
 * - Transient / scope / network failures stay inconclusive and are NOT
 *   rejected, so configuration can proceed while newly granted Contact scopes
 *   propagate.
 * - ou_ entries that the target app can resolve are normalized to the
 *   cross-app-stable on_ union_id where possible.
 *
 * ou_ and on_ share ONE definitive-miss test so the two id shapes can never
 * drift apart. The contact lookup is injected (narrow interface) so this module
 * stays SDK-free and unit-testable with fakes; routes.ts wires it to
 * LarkCardService's contact methods.
 */

/** open_id belongs to another app. Retrying with the same app can never fix it. */
const CROSS_APP_OPEN_ID_CODE = 99992361;
/**
 * Codes that prove an id is unusable by the target app, as opposed to a
 * transient/scope error that may resolve on retry.
 */
const DEFINITIVE_USER_ID_CODES = new Set<number>([CROSS_APP_OPEN_ID_CODE, 41012, 40001]);

/**
 * Dig a Lark error code out of the three shapes the SDK / HTTP layer can
 * produce: err.response.data.code (Axios), err.data.code (SDK business error),
 * err.code (plain normalized error). Returns undefined when no numeric code is
 * present (network/transport errors) — those stay inconclusive.
 */
export function larkErrorCode(err: unknown): number | undefined {
  const value = err as { code?: unknown; response?: { data?: { code?: unknown } }; data?: { code?: unknown } } | null | undefined;
  for (const candidate of [value?.response?.data?.code, value?.data?.code, value?.code]) {
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

export type ContactIdType = 'open_id' | 'union_id';

export interface ContactUser {
  openId?: string;
  unionId?: string;
}

/**
 * Narrow contact lookup injected by the routes layer (backed by
 * LarkCardService's contact methods).
 *
 * Contract:
 * - Returns the user on a clean code:0 response that contains a user.
 * - Returns undefined on a clean code:0 response with NO user (definitive miss).
 * - Throws on non-zero business codes and transport errors. The thrown error
 *   MUST expose the Lark code via err.code / err.data.code /
 *   err.response.data.code so definitive codes can be recognized; throws
 *   without a digable code are treated as inconclusive.
 */
export interface ContactLookup {
  getUser(id: string, idType: ContactIdType): Promise<ContactUser | undefined>;
  batchGetIdByEmail(email: string): Promise<string | undefined>;
  batchGetIdByMobile(mobile: string): Promise<string | undefined>;
}

const isOpenIdEntry = (entry: string) => entry.startsWith('ou_');
const isUnionIdEntry = (entry: string) => entry.startsWith('on_');

/** 去掉手机号里的空格与连字符（用户可能填 "+86 130-1111-2222"），便于校验/解析。 */
const normalizeMobileEntry = (entry: string) => entry.trim().replace(/[\s-]/g, '');
/**
 * 手机号条目：`+` 开头的 E.164（6–15 位数字）或 11 位大陆号（1 开头）。
 * 收紧规则避免把邮箱前缀/随手输入误判成手机号。
 */
const isMobileEntry = (entry: string) => /^(?:\+\d{6,15}|1\d{10})$/.test(normalizeMobileEntry(entry));
/** 完整邮箱（含 @ 和域名），区分"完整邮箱"与"邮箱前缀"。 */
const isEmailEntry = (entry: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.trim());

const isDefinitiveUserIdCode = (code: number | undefined): boolean =>
  code !== undefined && DEFINITIVE_USER_ID_CODES.has(code);

/**
 * Best-effort detection of owner entries that are definitively unusable by the
 * target app. Transient/scope errors remain inconclusive and are not rejected.
 */
export async function detectUnusableOwnerEntries(entries: string[], lookup: ContactLookup): Promise<string[]> {
  const unusable: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    try {
      if (isOpenIdEntry(entry) || isUnionIdEntry(entry)) {
        // ou_ and on_ share ONE definitive-miss test (see module header) so the
        // two id shapes can never drift apart. A prior ou_-only 99992361 check
        // let a target-app-invalid open_id (41012 / 40001) or a
        // code:0-without-user response slip through and be written as the sole
        // owner — the same lockout this module exists to prevent.
        const user = await lookup.getUser(entry, isOpenIdEntry(entry) ? 'open_id' : 'union_id');
        // A clean response without a target-app user is a definitive miss
        // (cross-app open_id, or a union_id this app cannot resolve).
        // Permission/scope failures arrive as throws and stay inconclusive so
        // configuration can proceed while newly granted Contact scopes propagate.
        if (!user?.openId) unusable.push(entry);
      } else if (isMobileEntry(entry)) {
        const userId = await lookup.batchGetIdByMobile(normalizeMobileEntry(entry));
        if (!userId) unusable.push(entry);
      } else if (isEmailEntry(entry)) {
        const userId = await lookup.batchGetIdByEmail(entry);
        if (!userId) unusable.push(entry);
      }
      // 其它形态（邮箱前缀等）留给下游校验，不在此拒绝。
    } catch (err) {
      // The SDK often throws Axios errors for the same cross-app response that
      // mocks expose as a normal payload. Preserve the definitive verdict in
      // both transport shapes; every other throw remains inconclusive. ou_ and
      // on_ use the SAME definitive-code set here too — an ou_-only 99992361
      // check would drop 41012 / 40001 that arrive as a throw.
      if ((isOpenIdEntry(entry) || isUnionIdEntry(entry)) && isDefinitiveUserIdCode(larkErrorCode(err))) {
        unusable.push(entry);
      }
    }
  }
  return unusable;
}

export interface NormalizeOwnerOptions {
  /**
   * When true (default), ou_ entries that the target app resolves to a union_id
   * are replaced by the cross-app-stable on_ form. When false, ou_ entries are
   * kept as-is even when a union_id is available (used by storage layers that
   * can only persist ou_).
   */
  preferUnionId?: boolean;
}

/**
 * Normalize owner entries to the most stable form the target app can prove:
 * ou_ → on_ union_id when resolvable. Entries that cannot be resolved
 * (inconclusive lookup) and already-stable forms (on_, email, mobile) are kept
 * as-is. Never throws — a failed/inconclusive lookup preserves the original.
 */
export async function normalizeOwnerEntries(entries: string[], lookup: ContactLookup, options: NormalizeOwnerOptions = {}): Promise<string[]> {
  const preferUnionId = options.preferUnionId !== false;
  const normalized: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    normalized.push(trimmed);
  };
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (!preferUnionId || !isOpenIdEntry(entry)) {
      push(entry);
      continue;
    }
    try {
      const user = await lookup.getUser(entry, 'open_id');
      push(user?.unionId?.startsWith('on_') ? user.unionId : entry);
    } catch {
      // 解析失败（inconclusive）保留原值，运行时仍可按 ou_ 匹配。
      push(entry);
    }
  }
  return normalized;
}

export interface AssertOwnersOptions {
  /**
   * True when persisting a brand-new bot (no existing config). No open_id can
   * belong to an app that does not exist yet, so every ou_ entry is rejected
   * without a lookup — there is no source app to convert it through.
   */
  creatingApp?: boolean;
}

/**
 * Assert that every owner entry is usable by the target app. Throws a Chinese
 * error guiding the caller to email / mobile / on_ when an ou_ cannot be used.
 * Uses {@link detectUnusableOwnerEntries} for the target-app verdict.
 */
export async function assertOwnersUsableForApp(entries: string[], lookup: ContactLookup, options: AssertOwnersOptions = {}): Promise<void> {
  const openIds = entries.map(entry => entry.trim()).filter(isOpenIdEntry);
  if (options.creatingApp && openIds.length > 0) {
    throw new Error(
      `保存新机器人时不能使用 app-scoped open_id（${openIds.join(', ')}）：open_id 只对签发它的应用有效，新应用还不存在、无法归属任何 open_id。请改用完整邮箱、手机号或 on_ union_id。`,
    );
  }
  const unusable = await detectUnusableOwnerEntries(entries, lookup);
  if (unusable.length > 0) {
    throw new Error(
      `以下白名单条目无法通过目标应用校验，不能保存：${unusable.join(', ')}。open_id 只对签发它的应用有效，跨应用复制会导致 owner 被锁死。请改用完整邮箱、手机号或 on_ union_id，或先在目标应用下通过姓名解析。`,
    );
  }
}
