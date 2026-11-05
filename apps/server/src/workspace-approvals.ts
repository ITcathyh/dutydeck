import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { parse } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RuntimeError, deriveWorkspaceApprovalRule, matchWorkspaceApprovalRules, type PermissionRequestData, type Session, type WorkspaceApprovalRule, type WorkspaceApprovalRuleRepository } from '@dutydeck/shared';
import type { LarkWorkspaceApprovalScope, LarkWorkspaceApprovals } from './lark/workflow-interactions.js';

export interface WorkspaceApprovalOptions {
  rules: WorkspaceApprovalRuleRepository;
  getSession(id: string): Promise<Session | undefined>;
  /** 这一轮由哪位飞书用户亲自发起；定时、自动化、触发器、Web 或安装管理员发起的返回 undefined。 */
  humanRequester(taskId: string): string | undefined;
}

/**
 * 按工作区记住的审批规则（审批卡「本工作区允许此类命令」）。规则按机器人（appId）隔离，不跨机器人共享。
 * 只作用于飞书来源、非完全信任会话里由飞书用户亲自发起、且发起人就是这张卡的发起人的轮次；
 * 工作区是会话执行目录的真实路径（不用 Agent 报的 operation.cwd），每次都重新解析、重新查库；
 * 家目录和文件系统根覆盖面太大，不能作为工作区。
 * 命令只认执行端交来的字符串原文（commandExact），高危正则由调用方在每次匹配前重跑。
 */
export class WorkspaceApprovals implements LarkWorkspaceApprovals {
  constructor(private readonly options: WorkspaceApprovalOptions) {}

  private async workspace(scope: LarkWorkspaceApprovalScope) {
    if (!scope.requester || this.options.humanRequester(scope.taskId) !== scope.requester) return undefined;
    const session = await this.options.getSession(scope.sessionId);
    if (!session || session.source !== 'lark' || session.permissionMode === 'full-trust') return undefined;
    return realpath(session.cwd).then(path => WorkspaceApprovals.allowedWorkspace(path)).catch(() => undefined);
  }

  /** 家目录（真实路径）和文件系统根不能建规则，也不按规则放行。 */
  private static async allowedWorkspace(path: string) {
    const home = await realpath(homedir()).catch(() => homedir());
    return path === home || path === parse(path).root ? undefined : path;
  }

  private static command(request: PermissionRequestData) {
    const operation = request.operation;
    return operation?.commandExact === true && operation.command ? operation.command : undefined;
  }

  async candidate(scope: LarkWorkspaceApprovalScope, request: PermissionRequestData) {
    const command = WorkspaceApprovals.command(request);
    const pattern = command && deriveWorkspaceApprovalRule(command);
    const workspace = pattern ? await this.workspace(scope) : undefined;
    return pattern && workspace ? { workspace, pattern } : undefined;
  }

  async match(scope: LarkWorkspaceApprovalScope, request: PermissionRequestData) {
    const command = WorkspaceApprovals.command(request);
    const workspace = command ? await this.workspace(scope) : undefined;
    if (!command || !workspace) return undefined;
    return matchWorkspaceApprovalRules(command, this.options.rules.list({ appId: scope.appId, workspace }))?.map(rule => rule.pattern).join('、');
  }

  async remember(rule: { appId: string; workspace: string; pattern: string }, createdBy: string) {
    // 只保存本模块推导得出的规则写法，防止持久记录被改写后带进宽规则。
    if (deriveWorkspaceApprovalRule(rule.pattern) !== rule.pattern) throw new Error('Workspace approval rule is not derivable');
    if (!await WorkspaceApprovals.allowedWorkspace(rule.workspace)) throw new Error('Workspace approval rules cannot cover the home directory or the filesystem root');
    this.options.rules.add({ appId: rule.appId, workspace: rule.workspace, pattern: rule.pattern, createdBy });
  }

  /** workspace 传目录时按真实路径过滤；目录不存在时按原样过滤（已删除目录的旧规则仍可查到、撤销）。 */
  async list(filter: { appId?: string; workspace?: string } = {}): Promise<WorkspaceApprovalRule[]> {
    const workspace = filter.workspace === undefined ? undefined : await realpath(filter.workspace).catch(() => filter.workspace);
    return this.options.rules.list({ ...(filter.appId ? { appId: filter.appId } : {}), ...(workspace ? { workspace } : {}) });
  }

  remove(id: string) { return this.options.rules.remove(id); }
}

export interface WorkspaceApprovalRouteOptions {
  service: Pick<WorkspaceApprovals, 'list' | 'remove'>;
  /** 安装管理员校验；规则跨所有 Bot 与工作区，未授权一律 403。 */
  authorize(request: FastifyRequest): Promise<boolean> | boolean;
}

const listQuery = z.object({ app: z.string().trim().min(1).max(256).optional(), workspace: z.string().trim().min(1).max(4096).optional() }).strict();

/** Web 设置与 `dutydeck settings approval-rules` 共用：只能查看和撤销，新增只能在飞书审批卡上点。 */
export function registerWorkspaceApprovalRoutes(app: FastifyInstance, options: WorkspaceApprovalRouteOptions) {
  const authorize = async (request: FastifyRequest) => {
    if (!await options.authorize(request)) throw new RuntimeError('APPROVAL_RULES_OWNER_REQUIRED', '安装管理员授权后才能查看和撤销工作区审批规则', 403);
  };
  app.get('/api/workspace-approval-rules', async request => {
    await authorize(request);
    const query = listQuery.parse(request.query);
    return { rules: await options.service.list({ appId: query.app, workspace: query.workspace }) };
  });
  app.delete<{ Params: { id: string } }>('/api/workspace-approval-rules/:id', async request => {
    await authorize(request);
    if (!options.service.remove(request.params.id)) throw new RuntimeError('APPROVAL_RULE_NOT_FOUND', '这条规则不存在或已撤销', 404);
    return { removed: request.params.id };
  });
}
