import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RuntimeError, type AgentConfig, type RepositoryBundle } from '@dutydeck/shared';
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
const key = (id: string) => `dutydeck.agent_model.${id}`;
const isClaudeCode = (agent: AgentConfig) => ['claude', 'claude-code'].includes(agent.adapterId ?? agent.id);

export class AgentModelSettings {
  constructor(private readonly repos: Pick<RepositoryBundle, 'config' | 'agents'>, private readonly defaults: AgentConfig[], private readonly provider?: LocalFileSecretProvider) {}
  private baseline(id: string) {
    const agent = this.defaults.find(item => item.id === id);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', 'Unknown agent', 404);
    if (!isClaudeCode(agent)) throw new RuntimeError('AGENT_MODEL_SETTINGS_UNSUPPORTED', '目前只支持 Claude Code 的模型服务配置', 400);
    return agent;
  }
  private async read(id: string) { return storedSchema.parse(JSON.parse(await this.repos.config.get(key(id)) ?? '{}')); }
  async get(id: string) {
    const agent = this.baseline(id), saved = await this.read(id);
    return { agentId: id, model: saved.model || agent.model || '', baseUrl: saved.baseUrl || '', authMode: saved.authMode ?? 'bearer', hasApiKey: Boolean(saved.referenceKey), apiKeyAvailable: Boolean(saved.referenceKey && this.provider?.inspect(saved.referenceKey).availability === 'available'), appliesTo: 'next_process' as const };
  }
  async set(id: string, body: unknown) {
    const baseline = this.baseline(id), patch = agentModelSettingsPatchSchema.parse(body), current = await this.read(id);
    const { apiKey, clearApiKey, ...fields } = patch;
    const saved = { ...current, ...fields };
    if (apiKey || clearApiKey) {
      if (!this.provider) throw new RuntimeError('AGENT_SECRET_PROVIDER_UNAVAILABLE', '持久化密钥存储不可用', 503);
      if (clearApiKey) {
        if (saved.referenceKey && this.provider.inspect(saved.referenceKey).availability === 'available') this.provider.removeConditional(saved.referenceKey);
        delete saved.referenceKey;
      } else {
        const available = saved.referenceKey && this.provider.inspect(saved.referenceKey).availability === 'available';
        const referenceKey = available ? saved.referenceKey! : `agent-api-${randomUUID()}`;
        if (available) this.provider.replaceConditional(referenceKey, Buffer.from(apiKey!, 'utf8'), this.provider.fingerprint(referenceKey));
        else this.provider.writeExclusive(referenceKey, Buffer.from(apiKey!, 'utf8'));
        saved.referenceKey = referenceKey;
      }
    }
    await this.repos.config.set(key(id), JSON.stringify(saved));
    const agent = await this.repos.agents.get(id);
    if (agent) await this.repos.agents.save({ ...agent, model: saved.model || baseline.model });
    return this.get(id);
  }
  async defaultsForBoot(agents: AgentConfig[]) {
    return Promise.all(agents.map(async agent => ({ ...agent, model: (await this.read(agent.id)).model || agent.model })));
  }
  async resolve(agent: AgentConfig): Promise<AgentConfig> {
    if (!isClaudeCode(agent)) return agent;
    const saved = await this.read(agent.id);
    if (!saved.referenceKey) return agent;
    const env = { ...agent.env, ...(saved.baseUrl ? { ANTHROPIC_BASE_URL: saved.baseUrl } : {}) };
    if (!this.provider) throw new RuntimeError('AGENT_SECRET_PROVIDER_UNAVAILABLE', '持久化密钥存储不可用', 503);
    return new LocalFileAgentApiKeyResolver(this.provider).withApiKey(saved.referenceKey, apiKey => ({ ...agent, env: { ...env, ANTHROPIC_API_KEY: saved.authMode === 'api-key' ? apiKey : '', ANTHROPIC_AUTH_TOKEN: saved.authMode === 'api-key' ? '' : apiKey, CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0' } }));
  }
}
