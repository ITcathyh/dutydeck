import { botAppIdOfSession, parseLarkSourceId, pluginToolActionPrefix, redactCredentialText, RuntimeError, type ConfigurationExplanation, type ConfigurationField, type ConfigurationSection, type PluginToolAction, type RepositoryBundle, type SkillDeliveryMetadata } from '@dutydeck/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { LarkGroupManager } from './lark/group-management.js';
import { readLarkConfig } from './lark/config.js';
import type { PluginHost } from './plugins/host.js';
import { hasPluginTaskCredentials } from './plugins/management-auth.js';
import { prepareSkillPrompt } from './skill-delivery.js';

const labels = { agentId: 'Agent', cwd: '工作目录', model: '模型', reasoningEffort: '推理强度', permissionMode: '权限模式', codexProfile: 'Codex 配置档' };
const field = (key: string, label: string, value: string | number | boolean | undefined, source: string, reason?: string): ConfigurationField => ({ key, label, ...(value === undefined ? {} : { value: typeof value === 'string' ? redactCredentialText(value) : value }), status: value === undefined ? 'unset' : 'recorded', source, ...(reason ? { reason: redactCredentialText(reason) } : {}) });
const unknown = (key: string, label: string, source: string): ConfigurationField => ({ key, label, status: 'unknown', source, reason: '未记录；不使用当前设置还原历史。' });
const skillFields = (skills: SkillDeliveryMetadata[] | undefined, source: string): ConfigurationField[] => skills === undefined ? [unknown('skills', '技能交付', source)] : skills.length ? skills.map((skill, index) => field(`skill.${index}`, `技能 ${skill.name}`, `${skill.status ?? 'included'} · ${skill.source} · ${skill.digest}`, source, `${skill.required ? '必需；' : ''}${skill.ref ?? skill.path}${skill.binding ? `；绑定 ${skill.binding.id} revision ${skill.binding.revision}` : ''}`)) : [field('skills', '技能交付', '无', source)];
export interface ConfigurationExplanationOptions {
  repositories: Pick<RepositoryBundle, 'sessions' | 'agents' | 'config' | 'execution'>;
  groups?: Pick<LarkGroupManager, 'explain'>;
  host?: PluginHost;
  authorize(request: FastifyRequest, sessionId: string): Promise<boolean>;
}

export async function explainConfiguration(options: Omit<ConfigurationExplanationOptions, 'authorize'>, sessionId: string, selection: { taskId?: string; attemptId?: string } = {}): Promise<ConfigurationExplanation> {
  const repos = options.repositories;
  const session = await repos.sessions.get(sessionId);
  if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
  const agent = await repos.agents.get(session.agentId);
  const sections: ConfigurationSection[] = [];
  const appId = botAppIdOfSession(session);
  const origin = parseLarkSourceId(session.sourceId);
  const bot = appId ? await readLarkConfig(repos.config, appId, { readOnly: true }) : undefined;
  const group = appId && origin.chatId && origin.chatType === 'group' ? await options.groups?.explain(appId, origin.chatId) : undefined;
  const saved = Object.entries(labels).map(([key, label]) => field(key, label, key === 'agentId' ? agent?.id : agent?.[key as Exclude<keyof typeof labels, 'agentId'>], 'Agent 已保存默认', '后续启动的默认值；显式启动参数仍可覆盖。'));
  // These are the existing resolver's observations, not a second implementation of its precedence.
  if (bot) {
    saved.push(...[
      field('bot.agent', '机器人默认 Agent', bot.defaultAgentId, '机器人已保存配置'),
      field('bot.model', '机器人默认模型', bot.defaultModel, '机器人已保存配置'),
      field('bot.cwd', '机器人工作目录', bot.workspace, '机器人已保存配置'),
      field('bot.permission', '机器人权限模式', bot.permissionMode, '机器人已保存配置')
    ]);
  }
  if (group?.effective) {
    for (const [key, label] of [['agent', '群 Agent'], ['workspace', '群工作目录'], ['model', '群模型'], ['reasoningEffort', '群推理强度']] as const) {
      const result = group.effective[key];
      saved.push({ ...field(`group.${key}`, label, result.value, result.source, result.source === 'group_clear' ? '群显式清空；后续运行沿用原有启动解析规则。' : '来自实际群配置解析器。'), revision: group.binding?.revision });
    }
    saved.push(field('group.applied', '群执行配置可用', group.applied, '群身份和启用状态', group.error));
    for (const [key, result] of Object.entries(group.effective.groupTools)) saved.push(field(`group.tools.${key}`, `群工具 ${key}`, result.allowed, result.source, result.source === 'bot_ceiling' ? '机器人上限禁止此能力。' : undefined));
  }
  sections.push({ phase: 'saved', title: '已保存 · 后续启动', note: '按层展示已保存默认与群解析结果；创建时指定的值、分流选择和 CLI 默认仍由原启动链决定，不会修改当前会话。', fields: saved });
  sections.push({ phase: 'session', title: '当前会话', note: '来自持久化会话记录；不等于历史任务或外部 CLI 的全部实际配置。', fields: Object.entries(labels).map(([key, label]) => field(key, label, session[key as keyof typeof labels], '当前会话记录')) });
  const projections = repos.execution.getSessionExecutions(sessionId);
  const tasks = projections.map(({ task, attempts }) => ({ id: task.id, attempts: attempts.map(attempt => ({ id: attempt.attemptId, number: attempt.number, state: attempt.state })) }));
  let attemptId: string | undefined;
  if (selection.taskId) {
    const projection = projections.find(item => item.task.id === selection.taskId);
    if (!projection) throw new RuntimeError('TASK_NOT_FOUND', 'Task not found in this session', 404);
    const attempt = selection.attemptId ? projection.attempts.find(item => item.attemptId === selection.attemptId) : projection.currentAttempt;
    if (selection.attemptId && !attempt) throw new RuntimeError('ATTEMPT_NOT_FOUND', 'Attempt not found in this task', 404);
    attemptId = attempt?.attemptId;
    const accepted = repos.execution.getAcceptedTask(selection.taskId);
    const input = accepted?.input;
    const execution = input?.version === 2 ? input.executionOptions : undefined;
    const historical: ConfigurationField[] = [unknown('agentId', 'Agent', '任务快照'), unknown('cwd', '工作目录', '任务快照')];
    for (const key of ['model', 'reasoningEffort', 'permissionMode'] as const) historical.push(execution ? field(key, labels[key], execution[key], '已接受任务的不可变执行选项', '该快照由 attempt 使用；不代表已提交给模型。') : unknown(key, labels[key], '任务快照'));
    historical.push(...skillFields(input?.executionContext.skillDeliveries, '已接受任务的技能交付快照'));
    for (const [index, part] of (input?.contentSources ?? []).entries()) historical.push(field(`source.${index}`, `上下文 ${part.kind}`, part.digest, '已接受任务内容来源', part.version ? `版本 ${part.version}` : '版本未记录'));
    for (const [index, part] of (input?.executionContext.promptParts ?? []).entries()) historical.push(part.digest ? field(`prompt.${index}`, `提示来源 ${part.kind}`, part.digest, '已接受任务提示快照', part.version ? `版本 ${part.version}` : '版本未记录') : unknown(`prompt.${index}`, `提示来源 ${part.kind}`, '提示快照未记录 digest；正文不展示'));
    if (attempt) historical.push(field('submission', '原生提交状态', attempt.submissionState, '指定 attempt 执行账本'), field('attemptState', '执行状态', attempt.state, '指定 attempt 执行账本'));
    sections.push({ phase: 'attempt', title: '指定任务 / attempt', note: attempt ? `任务 ${selection.taskId} · attempt ${attempt.number}（${attempt.attemptId}）；接受时快照与提交状态分开显示。` : '任务尚无 attempt；以下仅为接受时证据。', fields: historical });
    const calls: ConfigurationField[] = [];
    for (const row of await repos.config.list?.(pluginToolActionPrefix) ?? []) {
      const action = JSON.parse(row.value) as PluginToolAction;
      if (action.original.sessionId !== sessionId || action.original.taskId !== selection.taskId || !attemptId || action.original.attemptId !== attemptId) continue;
      calls.push(field(action.id, `${action.plugin}/${action.tool}`, action.status, '插件动作调用账本', `绑定 ${action.bindingId} revision ${action.bindingRevision}；处理器 ${action.handlerVersion}；${action.createdAt}`));
    }
    sections.push({ phase: 'tool_call', title: '指定 attempt 的工具调用', note: '动作账本记录调用时绑定 revision；每次调用重新解析并授权。查询工具、提前拒绝和未落账的调用未记录，不能推断权限结论。', fields: calls.length ? calls : [unknown('calls', '工具调用', '插件动作调用账本')] });
  }
  if (options.host) {
    const scope = { botAppId: appId, chatId: origin.chatId, cwd: session.workspaceSourceCwd ?? session.cwd };
    const plugins: ConfigurationField[] = [];
    const names = new Set([...options.host.active.map(item => item.entry.name), ...options.host.bindings.list().map(item => item.plugin)]);
    for (const name of names) {
      const selected = options.host.bindings.select(name, scope);
      if (!selected) continue;
      try {
        const resolved = await options.host.resolveBinding(name, scope);
        plugins.push({ ...field(`plugin.${name}`, `插件 ${name}`, resolved ? '已启用' : '无工具绑定', '本次查询的插件解析结果', `绑定 ${selected.id}；配置值和密钥正文不展示。`), revision: resolved?.revision ?? selected.revision });
      } catch (error) { plugins.push({ ...field(`plugin.${name}`, `插件 ${name}`, error instanceof RuntimeError ? error.code : 'PLUGIN_RESOLUTION_FAILED', '本次查询的插件解析结果', '当前绑定不可用；未执行工具。'), revision: selected.revision }); }
    }
    try {
      const required = await options.host.requiredSkillRequests(scope);
      const prepared = await prepareSkillPrompt(scope.cwd, '', [], { botAppId: appId, chatId: origin.chatId, pluginRoots: options.host.skillEntries({ workspaceRoot: scope.cwd, botAppId: appId, chatId: origin.chatId }), requiredSkills: required.map(item => ({ ref: item.ref, binding: { id: item.binding.id, revision: item.binding.revision } })) });
      plugins.push(...skillFields(prepared.skillDeliveries, '当前必需技能交付预检（未注入）'));
    } catch (error) { plugins.push(field('skills.preflight', '必需技能预检', error instanceof RuntimeError ? error.code : 'SKILL_PREFLIGHT_FAILED', '真实技能交付解析器', '保留缺失、歧义和安全边界的拒绝结果；未注入。')); }
    sections.push({ phase: 'saved', title: '插件 · 当前解析预览', note: '此处是查询时预览。插件工具每次调用重新解析绑定并检查授权；不代表整轮固定，也不授予调用权限。', fields: plugins });
  }
  sections.push({ phase: 'native', title: '外部 CLI 配置', note: '原生 CLI 自行加载的 MCP、Skills 和私有配置未核验（unverified）；不扫描秘密文件。环境变量、令牌、密钥正文均不展示。', fields: [{ key: 'native', label: 'CLI 私有配置', status: 'unverified', source: '无原生观测证据' }] });
  return { sessionId, observedAt: new Date().toISOString(), ...selection, ...(attemptId ? { attemptId } : {}), tasks, sections };
}

export function registerConfigurationExplanationRoutes(app: FastifyInstance, options?: ConfigurationExplanationOptions) {
  app.get<{ Params: { id: string } }>('/api/sessions/:id/configuration', async (request, reply) => {
    if (!options || hasPluginTaskCredentials(request) || !await options.authorize(request, request.params.id)) throw new RuntimeError('CONFIGURATION_FORBIDDEN', 'Installation administrator and session access are required', 403);
    const checked = z.object({ taskId: z.string().min(1).optional(), attemptId: z.string().min(1).optional() }).strict().refine(value => !value.attemptId || value.taskId).safeParse(request.query);
    if (!checked.success) throw new RuntimeError('CONFIGURATION_INVALID', 'Select a task before its attempt', 400);
    reply.header('Cache-Control', 'no-store');
    return explainConfiguration(options, request.params.id, checked.data);
  });
}
