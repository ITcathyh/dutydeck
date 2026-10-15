import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { botAppIdOfSession, RuntimeError, supportsAgentModelService, type AgentConfig, type RepositoryBundle, type Session } from '@dutydeck/shared';
import { LocalFileAgentApiKeyResolver, type LocalFileSecretProvider } from '@dutydeck/secret-provider';

const text = z.string().trim().max(512);
const baseUrl = text.refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}, '服务地址必须是 HTTP(S) URL，不能包含账号、查询参数或片段');
export const agentModelSettingsPatchSchema = z.object({
  model: text.optional(), baseUrl: baseUrl.optional(), authMode: z.enum(['bearer', 'api-key']).optional(),
  apiKey: z.string().trim().min(1).max(4096).refine(value => !/[\s\x00-\x1f\x7f]/.test(value), 'API Key 不能包含空白或控制字符').optional(), clearApiKey: z.boolean().optional()
}).strict().refine(value => !(value.apiKey && value.clearApiKey), '不能同时设置和清除 API Key');
export type AgentModelSettingsPatch = z.infer<typeof agentModelSettingsPatchSchema>;
const storedSchema = z.object({ model: text.optional(), baseUrl: baseUrl.optional(), authMode: z.enum(['bearer', 'api-key']).optional(), referenceKey: z.string().optional() }).strict();
const scopePart = (value: string) => encodeURIComponent(value).replaceAll('.', '%2E');
const botScopePrefix = (appId: string) => `dutydeck.bot_agent_model.${scopePart(appId)}.`;
const key = (id: string, appId?: string) => appId ? `${botScopePrefix(appId)}${scopePart(id)}` : `dutydeck.agent_model.${id}`;
const isClaudeCode = (agent: AgentConfig) => supportsAgentModelService(agent);

export class AgentModelSettings {
  constructor(private readonly repos: Pick<RepositoryBundle, 'config' | 'agents' | 'sessions'>, private readonly defaults: AgentConfig[], private readonly provider?: LocalFileSecretProvider) {}
  private baseline(id: string) {
    const agent = this.defaults.find(item => item.id === id);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', 'Unknown agent', 404);
    if (!isClaudeCode(agent)) throw new RuntimeError('AGENT_MODEL_SETTINGS_UNSUPPORTED', '目前只支持 Claude Code 的模型服务配置', 400);
    return agent;
  }
  private async read(id: string, appId?: string) { return storedSchema.parse(JSON.parse(await this.repos.config.get(key(id, appId)) ?? '{}')); }
  async get(id: string, appId?: string) {
    const agent = this.baseline(id), saved = await this.read(id, appId);
    return { agentId: id, ...(appId ? { appId } : {}), model: saved.model || agent.model || '', baseUrl: saved.baseUrl || '', authMode: saved.authMode ?? 'bearer', hasApiKey: Boolean(saved.referenceKey), apiKeyAvailable: Boolean(saved.referenceKey && this.provider?.inspect(saved.referenceKey).availability === 'available'), appliesTo: 'next_process' as const };
  }
  /** 引用的密钥文件确实由本实例管理时才条件删除，避免误删同名外部文件。 */
  private removeReferenceKeyIfAvailable(referenceKey: string | undefined) {
    if (referenceKey && this.provider?.inspect(referenceKey).availability === 'available') this.provider.removeConditional(referenceKey);
  }
  async set(id: string, body: unknown, appId?: string) {
    const baseline = this.baseline(id), patch = agentModelSettingsPatchSchema.parse(body), current = await this.read(id, appId);
    if (appId && patch.model !== undefined) throw new RuntimeError('BOT_MODEL_SETTING_REQUIRED', '机器人模型请使用默认模型设置（dutydeck settings bot set <app-id> defaultModel=...）', 400);
    const { apiKey, clearApiKey, ...fields } = patch;
    const saved = { ...current, ...fields };
    if (apiKey || clearApiKey) {
      if (!this.provider) throw new RuntimeError('AGENT_SECRET_PROVIDER_UNAVAILABLE', '持久化密钥存储不可用', 503);
      if (clearApiKey) {
        this.removeReferenceKeyIfAvailable(saved.referenceKey);
        delete saved.referenceKey;
      } else {
        const available = saved.referenceKey && this.provider.inspect(saved.referenceKey).availability === 'available';
        const referenceKey = available ? saved.referenceKey! : `agent-api-${randomUUID()}`;
        if (available) this.provider.replaceConditional(referenceKey, Buffer.from(apiKey!, 'utf8'), this.provider.fingerprint(referenceKey));
        else this.provider.writeExclusive(referenceKey, Buffer.from(apiKey!, 'utf8'));
        saved.referenceKey = referenceKey;
      }
    }
    await this.repos.config.set(key(id, appId), JSON.stringify(saved));
    const agent = await this.repos.agents.get(id);
    if (agent && !appId) await this.repos.agents.save({ ...agent, model: saved.model || baseline.model });
    return this.get(id, appId);
  }
  async clearBot(appId: string) {
    const entries = await this.repos.config.list?.(botScopePrefix(appId)) ?? [];
    for (const entry of entries) {
      const saved = storedSchema.parse(JSON.parse(entry.value));
      this.removeReferenceKeyIfAvailable(saved.referenceKey);
      await this.repos.config.set(entry.key, '{}');
    }
  }
  /**
   * Bot 改 appId（跨应用复制配置）后把模型服务设置搬到新作用域：存储条目原样搬过去，
   * 密钥引用名与 appId 无关、由新作用域继续持有，不删密钥文件。新作用域已有同 Agent
   * 设置时保留新方凭据，旧作用域那份成为孤儿才删密钥。最后旧条目清空（无通用删除键，
   * 沿用 '{}' 墓碑约定）。
   */
  async renameBot(oldAppId: string, newAppId: string) {
    const prefix = botScopePrefix(oldAppId);
    for (const entry of await this.repos.config.list?.(prefix) ?? []) {
      if (entry.value === '{}') continue;
      const agentId = decodeURIComponent(entry.key.slice(prefix.length));
      const targetKey = key(agentId, newAppId);
      if (await this.repos.config.get(targetKey)) {
        this.removeReferenceKeyIfAvailable(storedSchema.parse(JSON.parse(entry.value)).referenceKey);
      } else {
        await this.repos.config.set(targetKey, entry.value);
      }
      await this.repos.config.set(entry.key, '{}');
    }
  }
  async resolveForSession(agent: AgentConfig, session: Session, parentForSession: (id: string) => Promise<{ parentSessionId: string } | undefined>): Promise<AgentConfig> {
    let current: Session | undefined = session;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const appId = botAppIdOfSession(current);
      if (appId) return this.resolve(agent, appId);
      const parent = await parentForSession(current.id);
      current = parent ? await this.repos.sessions.get(parent.parentSessionId) : undefined;
    }
    return this.resolve(agent);
  }
  async defaultsForBoot(agents: AgentConfig[]) {
    return Promise.all(agents.map(async agent => ({ ...agent, model: (await this.read(agent.id)).model || agent.model })));
  }
  async resolve(agent: AgentConfig, appId?: string): Promise<AgentConfig> {
    if (!isClaudeCode(agent)) return agent;
    const scoped = appId ? await this.read(agent.id, appId) : undefined;
    const saved = scoped?.referenceKey ? scoped : await this.read(agent.id);
    if (!saved.referenceKey) return agent;
    const env = { ...agent.env, ...(saved.baseUrl ? { ANTHROPIC_BASE_URL: saved.baseUrl } : {}) };
    if (!this.provider) throw new RuntimeError('AGENT_SECRET_PROVIDER_UNAVAILABLE', '持久化密钥存储不可用', 503);
    return new LocalFileAgentApiKeyResolver(this.provider).withApiKey(saved.referenceKey, apiKey => ({ ...agent, env: { ...env, ANTHROPIC_API_KEY: saved.authMode === 'api-key' ? apiKey : '', ANTHROPIC_AUTH_TOKEN: saved.authMode === 'api-key' ? '' : apiKey, CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0' } }));
  }
}
