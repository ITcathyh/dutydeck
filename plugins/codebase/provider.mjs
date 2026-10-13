// Codebase 的 CI 提供方：只接 webhook（流水线结果、MR 状态），没有主动查询接口。
// 接口见 @dutydeck/shared 的 CiProvider；宿主负责重放窗口、去重、订阅匹配和清洗字段。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const CODEBASE_HOST = 'code.byted.org';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const text = (value, max = 500) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max)
  : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
const positive = value => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : undefined;
};
const branchName = value => text(value, 255)?.replace(/^refs\/heads\//, '');
const header = (headers, name) => { const value = headers?.[name]; return Array.isArray(value) ? value[0] : value; };
const tokensEqual = (left, right) => timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest()) && left.length === right.length;
const pipelineStates = { success: 'success', succeeded: 'success', passed: 'success', failed: 'failed', failure: 'failed' };
const mergeRequestActions = { open: 'open', opened: 'open', reopen: 'reopen', reopened: 'reopen', update: 'update', updated: 'update', merge: 'merge', merged: 'merge', close: 'close', closed: 'close' };
const pullRequestStates = { open: 'open', reopen: 'reopen', update: 'update', merge: 'merge', close: 'close' };

/** 秒、毫秒或 ISO / GitLab 风格（`2026-09-25 08:00:00 UTC`）时间统一成毫秒。 */
export function parseWebhookTime(value) {
  if (typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return undefined;
    return Math.round(number < 1e12 ? number * 1_000 : number);
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value.trim().replace(/ UTC$/, 'Z').replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 取 origin 指向的 Codebase 仓库（如 `group/repo`）；不是 Codebase 返回 undefined。 */
export function repositoryFromRemote(remote) {
  const value = String(remote ?? '').trim();
  const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(value);
  let host;
  let path;
  if (scp) { host = scp[1]; path = scp[2]; }
  else {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'ssh:') { host = url.hostname; path = url.pathname; }
    } catch { return undefined; }
  }
  if (host?.toLowerCase() !== CODEBASE_HOST || !path) return undefined;
  const slug = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(slug) || slug.split('/').some(part => part === '.' || part === '..')) return undefined;
  const parts = slug.split('/');
  return { owner: parts.slice(0, -1).join('/'), name: parts.at(-1), slug };
}

function failuresFrom(value) {
  if (!Array.isArray(value)) return [];
  return value.map(object).filter(Boolean).map(item => ({
    job: text(item.job ?? item.name, 200),
    stage: text(item.stage ?? item.step, 200),
    reason: text(item.reason ?? item.failure_reason, 300),
    log: typeof item.log === 'string' && item.log.trim() ? item.log : undefined
  }));
}

/**
 * 支持两种载荷：DutyDeck 信封（`type: codebase.pipeline | codebase.merge_request`）和
 * GitLab 风格的 `object_kind`。Codebase / EventHub 的原始载荷未拿到样本核实，字段按文档空缺处的常见写法兜底。
 * 返回值的 kind 用宿主的 pipeline / pull_request，state 已归一成宿主认识的取值。
 */
export function parseCodebaseEvent(body) {
  const outer = object(body);
  if (!outer) return undefined;
  // 转发方可能把原始事件包在 data / payload / event 里（未核实）。
  const direct = outer.type === 'codebase.pipeline' || outer.type === 'codebase.merge_request' || typeof outer.object_kind === 'string';
  const inner = direct ? outer : object(outer.data) ?? object(outer.payload) ?? object(outer.event);
  if (!inner) return undefined;
  const eventId = text(outer.event_id ?? outer.eventId ?? outer.id, 200);
  const occurredAt = parseWebhookTime(outer.timestamp ?? outer.event_time ?? outer.occurred_at ?? inner.timestamp ?? inner.event_time);
  if (inner.type === 'codebase.pipeline' || inner.type === 'codebase.merge_request') {
    const repository = text(inner.repository, 255);
    if (!repository) return undefined;
    const pipeline = inner.type === 'codebase.pipeline';
    const raw = String(text(pipeline ? inner.status : inner.action ?? inner.status, 40) ?? '').toLowerCase();
    const run = object(inner.pipeline);
    return {
      kind: pipeline ? 'pipeline' : 'pull_request', repository, branch: branchName(inner.branch), pullRequest: positive(inner.mr ?? inner.mrIid),
      headSha: text(inner.sha ?? inner.headSha, 64),
      state: (pipeline ? pipelineStates : mergeRequestActions)[raw] ?? raw,
      runId: text(run?.id, 64), url: text(run?.url ?? inner.url, 400), operator: text(inner.operator, 64),
      failures: failuresFrom(inner.failures), eventId, occurredAt
    };
  }
  if (inner.object_kind !== 'pipeline' && inner.object_kind !== 'merge_request') return undefined;
  const attributes = object(inner.object_attributes) ?? {};
  const repository = text(object(inner.project)?.path_with_namespace, 255);
  if (!repository) return undefined;
  const user = object(inner.user);
  const operator = text(user?.username ?? user?.name, 64);
  if (inner.object_kind === 'pipeline') {
    const mergeRequest = object(inner.merge_request);
    const builds = Array.isArray(inner.builds) ? inner.builds.map(object).filter(Boolean) : [];
    const status = String(attributes.status ?? '').toLowerCase();
    return {
      kind: 'pipeline', repository, branch: branchName(mergeRequest?.source_branch ?? attributes.ref), pullRequest: positive(mergeRequest?.iid),
      headSha: text(attributes.sha, 64), state: pipelineStates[status] ?? status,
      runId: text(attributes.id, 64), url: text(attributes.url, 400), operator,
      failures: failuresFrom(builds.filter(build => pipelineStates[String(build.status ?? '').toLowerCase()] === 'failed')),
      eventId, occurredAt: occurredAt ?? parseWebhookTime(attributes.finished_at ?? attributes.updated_at)
    };
  }
  const action = String(attributes.action ?? attributes.state ?? '').toLowerCase();
  return {
    kind: 'pull_request', repository, branch: branchName(attributes.source_branch), pullRequest: positive(attributes.iid),
    headSha: text(object(attributes.last_commit)?.id, 64), state: mergeRequestActions[action] ?? action, url: text(attributes.url, 400), operator,
    failures: [], eventId, occurredAt: occurredAt ?? parseWebhookTime(attributes.updated_at)
  };
}

/**
 * 两种校验方式，都用常量时间比较：
 * - 签名：`X-Dutydeck-Signature: sha256=<hex>`，HMAC-SHA256(secret, `${X-Dutydeck-Timestamp}.${原始请求体}`)；
 * - 令牌：`X-Dutydeck-Token`、`Authorization: Bearer` 或 URL 的 `token` 参数（EventHub / Codebase 表单只能填 URL 时用）。
 * 令牌模式下带了 X-Dutydeck-Timestamp 也交给宿主校验时间窗口。
 */
export function verifyCodebaseWebhook(secret, request) {
  const signature = header(request.headers, 'x-dutydeck-signature');
  const stamp = header(request.headers, 'x-dutydeck-timestamp')?.trim();
  if (signature !== undefined) {
    const signedAt = parseWebhookTime(stamp);
    if (!stamp || signedAt === undefined) return { ok: false, statusCode: 400, code: 'WEBHOOK_TIMESTAMP_MISSING', message: '签名请求缺少有效的 X-Dutydeck-Timestamp' };
    const expected = `sha256=${createHmac('sha256', secret).update(`${stamp}.`).update(request.rawBody).digest('hex')}`;
    if (!tokensEqual(signature.trim().toLowerCase(), expected)) return { ok: false, statusCode: 401, code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Webhook 签名无效' };
    return { ok: true, signedAt };
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(header(request.headers, 'authorization') ?? '')?.[1];
  const queryToken = request.query?.token;
  const token = header(request.headers, 'x-dutydeck-token') ?? bearer ?? (Array.isArray(queryToken) ? queryToken[0] : queryToken);
  if (!token || !tokensEqual(token.trim(), secret)) return { ok: false, statusCode: 401, code: 'WEBHOOK_TOKEN_INVALID', message: 'Webhook 令牌无效' };
  const signedAt = parseWebhookTime(stamp);
  return signedAt === undefined ? { ok: true } : { ok: true, signedAt };
}

/** @param {{ webhookSecret?: string }} options */
export function createCodebaseProvider(options = {}) {
  const secret = options.webhookSecret?.trim() || undefined;
  return {
    id: 'codebase',
    displayName: 'Codebase 流水线',
    changeRequestLabel: number => `MR !${number}`,
    matchRepository: repositoryFromRemote,
    ...(secret ? {
      webhook: {
        verify: request => verifyCodebaseWebhook(secret, request),
        parse(request) {
          let body;
          try { body = JSON.parse(request.rawBody.toString('utf8')); }
          catch { throw Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400, code: 'WEBHOOK_BODY_INVALID' }); }
          const event = parseCodebaseEvent(body);
          const eventId = header(request.headers, 'x-dutydeck-event-id')?.trim();
          return event && eventId ? { ...event, eventId } : event;
        }
      }
    } : {})
  };
}
