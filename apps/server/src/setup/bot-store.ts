/**
 * setup 写飞书机器人配置的落点。
 *
 * 默认 Agent 与 App Secret 在 Dutydeck 里都存在机器人配置（configs 表的 lark.bots，字段
 * defaultAgentId / appSecret），与 Dashboard、`dutydeck settings bot` 是同一份数据；
 * 守护进程的飞书监听也只读这份。`.env` 里没有默认 Agent 这个键，`dutydeck secret set`
 * 管的 SecretRef 是另一套（身份预检用），不参与监听——所以向导写的是这里。
 *
 * 打开数据库的规则与 `dutydeck lark create` 相同：经 createRepositories，机器人配置走 saveLarkConfig，
 * 复用它的校验、revision 与并发写入保护。
 */
import { existsSync } from 'node:fs';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, AgentRepository } from '@dutydeck/shared';
import { readLarkConfig, saveLarkConfig, type SaveLarkConfigInput } from '../lark/config.js';
import { LarkServiceError } from '../lark/service.js';

export class BotSetupApprovalError extends LarkServiceError {
  readonly next: string;
  constructor(appId: string) {
    const next = `dutydeck setup --lark-app-id ${appId} --agent <id>`;
    super('LARK_APPROVAL_UNSUPPORTED', `所选 Agent 不支持飞书审批，机器人配置未保存；此前已完成的开放平台绑定不会回滚。请选择支持审批的 Agent（ACP 或 Claude Code / Seed / Relay 终端模式），再运行 ${next}；向导不会自动开启完全信任。`, 422);
    this.next = next;
  }
}

export interface SaveBotInput {
  /** 数据库文件路径。 */
  database: string;
  appId: string;
  /** 新的 App Secret；省略则沿用已保存的。 */
  appSecret?: string;
  defaultAgentId?: string;
  /** 默认工作目录；只在机器人还没有工作目录时写入，不覆盖用户已改过的值。 */
  workspace?: string;
  listen?: boolean;
  /** 本机探测到的 Agent；数据库 agents 表在服务首次启动前是空的，校验 defaultAgentId 要靠它。 */
  knownAgents: ReadonlyArray<Pick<AgentConfig, 'id' | 'protocol'> & Partial<AgentConfig>>;
}

export interface SaveBotResult {
  /** 机器人配置里是否已有这个 appId（保存前）。 */
  existed: boolean;
  /** 是否写了库；已经是目标状态时为 false。 */
  changed: boolean;
  /** 保存后机器人是否带有 App Secret。 */
  hasSecret: boolean;
  defaultAgentId?: string;
  listening: boolean;
}

export type SaveBot = (input: SaveBotInput) => Promise<SaveBotResult>;

export interface ExistingBot {
  /** 仅用于把它交给 bind 同步斜杠命令，绝不输出。 */
  appSecret?: string;
  defaultAgentId?: string;
  listening: boolean;
}

/** 读取已保存的机器人；库不存在时返回 undefined，且不会为了读而创建它。 */
export type ReadBot = (database: string, appId: string) => Promise<ExistingBot | undefined>;

export const readBot: ReadBot = async (database, appId) => {
  if (!existsSync(database)) return undefined;
  const repositories = createRepositories(database);
  try {
    const bot = await readLarkConfig(repositories.config, appId, { readOnly: true });
    return bot ? { ...(bot.appSecret ? { appSecret: bot.appSecret } : {}), ...(bot.defaultAgentId ? { defaultAgentId: bot.defaultAgentId } : {}), listening: bot.listening } : undefined;
  } finally { repositories.close(); }
};

export const saveBot: SaveBot = async input => {
  const repositories = createRepositories(input.database);
  try {
    const agents = {
      ...repositories.agents,
      get: async (id: string) => await repositories.agents.get(id) ?? input.knownAgents.find(agent => agent.id === id) as AgentConfig | undefined
    } as AgentRepository;
    const current = await readLarkConfig(repositories.config, input.appId);
    if (!current && !input.appSecret) {
      throw new Error('机器人尚未保存，需要 App Secret 才能新建它。');
    }
    const workspace = current?.workspace ? undefined : input.workspace;
    const secret = input.appSecret && input.appSecret !== current?.appSecret ? input.appSecret : undefined;
    const agent = input.defaultAgentId && input.defaultAgentId !== current?.defaultAgentId ? input.defaultAgentId : undefined;
    const listen = input.listen === true && current?.listening !== true ? true : undefined;
    const base = { appSecret: current?.appSecret ?? input.appSecret, listening: current?.listening === true, defaultAgentId: current?.defaultAgentId };
    if (current && secret === undefined && agent === undefined && workspace === undefined && listen === undefined) {
      return { existed: true, changed: false, hasSecret: Boolean(base.appSecret), ...(base.defaultAgentId ? { defaultAgentId: base.defaultAgentId } : {}), listening: base.listening };
    }
    const patch: SaveLarkConfigInput = current
      ? { stage: 'lark', originalAppId: input.appId, expectedRevision: current.revision ?? 1 }
      // 新机器人：完全信任需要用户在 Dashboard 或 settings 里显式确认，向导不替用户决定。
      : { stage: 'lark', expectedRevision: 0, appId: input.appId, permissionMode: 'ask' };
    const saved = await saveLarkConfig(repositories.config, agents, {
      ...patch,
      ...(secret ? { appSecret: secret } : {}),
      ...(agent ? { defaultAgentId: agent } : {}),
      ...(workspace ? { workspace } : {}),
      ...(listen ? { listening: true } : {})
    });
    const bot = saved.find(config => config.appId === input.appId)!;
    return { existed: Boolean(current), changed: true, hasSecret: Boolean(bot.appSecret), ...(bot.defaultAgentId ? { defaultAgentId: bot.defaultAgentId } : {}), listening: bot.listening };
  } catch (error) {
    if (error instanceof LarkServiceError && error.code === 'LARK_APPROVAL_UNSUPPORTED') throw new BotSetupApprovalError(input.appId);
    throw error;
  } finally { repositories.close(); }
};
