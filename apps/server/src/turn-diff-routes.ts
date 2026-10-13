import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { installationOwnerTaskActor, RuntimeError, type ConfigRepository, type PolicyAction, type PolicyDecision } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { isValidTurnDiffCredential, SHARE_TOKEN_QUERY_KEY } from './auth/auth.js';
import { buildTurnDiffReviewPrompt, listTurnDiffRecords, readTurnDiff, readTurnDiffRecord, resolveTurnDiffComment, type TurnDiffReviewComment } from './turn-diff.js';

export type TurnDiffReviewRequest = { sessionId: string; taskId: string; comments: TurnDiffReviewComment[]; prompt: string };

export interface TurnDiffRouteOptions {
  store: ConfigRepository;
  /**
   * 只持有分享链接的人提交的行评论：在这一轮所在的飞书话题里发一张确认卡，有权限的人点了才交给 Agent。
   * no_origin：这一轮没有对应的飞书话题；unavailable：机器人没在监听或发卡失败。
   */
  requestLarkReview?(review: TurnDiffReviewRequest): Promise<'sent' | 'no_origin' | 'unavailable'>;
}

/** 分享链接上提交评论的频率：同一轮 10 分钟 3 次，整个服务 10 分钟 30 次。只记在内存里。 */
const REVIEW_WINDOW_MS = 10 * 60_000;
const REVIEW_PER_TURN = 3;
const REVIEW_TOTAL = 30;

const commentsBody = z.object({
  comments: z.array(z.object({
    path: z.string().min(1).max(1024),
    side: z.enum(['old', 'new']),
    line: z.number().int().min(1).max(10_000_000),
    body: z.string().trim().min(1).max(2000)
  }).strict()).min(1).max(20)
}).strict();

const titleOf = (prompt: string | undefined) => prompt?.trim().split('\n')[0]?.slice(0, 80) || undefined;

/**
 * 「查看改动」的接口。带 share 的请求只认「查看改动」token（只授权这一个会话的这一轮），读 diff、提交评论都不继承登录身份，
 * 评论也只能变成飞书确认卡；不带 share 的按登录用户与会话权限处理，评论直接作为同一会话的新一轮发给 Agent。
 */
export function registerTurnDiffRoutes(app: FastifyInstance, runtime: DutydeckRuntime, options: TurnDiffRouteOptions & {
  getShareSecret?(): Promise<string | null>;
  authorize(request: FastifyRequest, sessionId: string, action: PolicyAction): Promise<PolicyDecision | undefined>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const submissions: Array<{ key: string; at: number }> = [];
  /** 带 share 时核对 token（认证中间件在 token 模式下已核对过一次，没有中间件时只靠这里），返回是不是分享访问。 */
  const access = async (request: FastifyRequest, sessionId: string, taskId: string, action: PolicyAction): Promise<{ shared: boolean; decision?: PolicyDecision }> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(query, SHARE_TOKEN_QUERY_KEY)) {
      if (!await isValidTurnDiffCredential(query[SHARE_TOKEN_QUERY_KEY], sessionId, taskId, options.getShareSecret, now())) throw new RuntimeError('UNAUTHORIZED', 'Authentication required', 401);
      return { shared: true };
    }
    return { shared: false, decision: await options.authorize(request, sessionId, action) };
  };
  const load = async (sessionId: string, taskId: string) => {
    const record = await readTurnDiffRecord(options.store, sessionId, taskId);
    if (!record?.after || !record.summary) throw new RuntimeError('TURN_DIFF_NOT_FOUND', '这一轮没有记录到改动', 404);
    try { return { record, diff: await readTurnDiff(record.gitDir, record.before, record.after) }; }
    catch { throw new RuntimeError('TURN_DIFF_EXPIRED', '这一轮的改动记录已经不在仓库里了（仓库被清理或移走）', 410); }
  };

  app.get<{ Params: { id: string } }>('/api/sessions/:id/diffs', async request => {
    await options.authorize(request, request.params.id, 'task.view_result');
    return (await listTurnDiffRecords(options.store, request.params.id)).map(record => ({ taskId: record.taskId, summary: record.summary, finishedAt: record.finishedAt }));
  });

  app.get<{ Params: { id: string; taskId: string } }>('/api/sessions/:id/tasks/:taskId/diff', async request => {
    const { id, taskId } = request.params;
    const { shared } = await access(request, id, taskId, 'task.view_result');
    const { record, diff } = await load(id, taskId);
    const task = (await runtime.getTasks(id)).find(item => item.id === taskId);
    return { sessionId: id, taskId, title: titleOf(task?.prompt), finishedAt: record.finishedAt, ...diff, access: shared ? 'shared' : 'owner' };
  });

  app.post<{ Params: { id: string; taskId: string } }>('/api/sessions/:id/tasks/:taskId/diff/comments', async (request, reply) => {
    const { id, taskId } = request.params;
    const { shared, decision } = await access(request, id, taskId, 'turn.append');
    if (shared) {
      const at = now();
      while (submissions.length && submissions[0]!.at <= at - REVIEW_WINDOW_MS) submissions.shift();
      const key = `${id}\0${taskId}`;
      if (submissions.length >= REVIEW_TOTAL || submissions.filter(item => item.key === key).length >= REVIEW_PER_TURN) {
        throw new RuntimeError('TURN_DIFF_REVIEW_RATE_LIMITED', '提交太频繁了，请过几分钟再试', 429);
      }
      submissions.push({ key, at });
    }
    const body = commentsBody.parse(request.body ?? {});
    const { diff } = await load(id, taskId);
    const comments = body.comments.map(item => {
      const code = resolveTurnDiffComment(diff.files, item);
      if (code === undefined) throw new RuntimeError('INVALID_COMMENT_LINE', `${item.path} 第 ${item.line} 行不在这一轮的改动里`, 400);
      return { path: item.path, side: item.side, line: item.line, code, comment: item.body };
    });
    const prompt = buildTurnDiffReviewPrompt(comments, { untrusted: shared });
    if (!shared) {
      const task = await runtime.dispatch(id, prompt, 'queue', prompt, undefined, decision?.source === 'owner' ? installationOwnerTaskActor : undefined);
      return reply.code(202).send({ delivery: 'dispatched', task });
    }
    if (!options.requestLarkReview) throw new RuntimeError('TURN_DIFF_REVIEW_UNAVAILABLE', '暂时不能转交评论，请登录 Web 后提交', 503);
    const outcome = await options.requestLarkReview({ sessionId: id, taskId, comments, prompt });
    if (outcome === 'no_origin') throw new RuntimeError('TURN_DIFF_REVIEW_NO_TOPIC', '这一轮不是从飞书话题发起的，分享链接上的评论没有地方确认；请登录 Web 后提交', 409);
    if (outcome !== 'sent') throw new RuntimeError('TURN_DIFF_REVIEW_UNAVAILABLE', '机器人暂时发不出确认卡，请稍后再试', 503);
    return reply.code(202).send({ delivery: 'lark_confirmation' });
  });
}
