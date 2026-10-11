import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agentModelSettingsApi, type AgentModelSettingsPatch } from '../api';
import { currentInstance } from '../instance';
import { clearCachedAgentModels } from '../model-cache';
import { Banner, Button, Field, Input, Select, Spinner } from './primitives';

export function AgentModelSettings({ agentId }: { agentId: string }) {
  const client = useQueryClient();
  const key = ['agent-model-settings', currentInstance(), agentId];
  const query = useQuery({ queryKey: key, queryFn: () => agentModelSettingsApi.get(agentId), retry: false });
  const [draft, setDraft] = useState<AgentModelSettingsPatch>({});
  const save = useMutation({
    mutationFn: (patch: AgentModelSettingsPatch) => agentModelSettingsApi.set(agentId, patch),
    onSuccess: async data => {
      setDraft({});
      client.setQueryData(key, data);
      clearCachedAgentModels(agentId);
      client.removeQueries({ queryKey: ['agent-models', agentId] });
      await client.invalidateQueries({ queryKey: ['agents'] });
    }
  });
  const change = (patch: AgentModelSettingsPatch) => { setDraft(value => ({ ...value, ...patch })); save.reset(); };
  return <details className="mt-3 text-caption text-secondary">
    <summary className="cursor-pointer font-semibold text-primary">模型服务配置</summary>
    <p className="mt-2">可填写兼容 Claude API 的服务地址和密钥。服务地址需配置 API Key 才会启用；清除密钥后恢复 CLI 连接配置。保存后在下次启动 Agent 进程时生效；已运行的会话需重新创建才能立即使用。</p>
    {query.isLoading ? <Spinner/> : query.isError ? <Banner tone="danger" action={{ label: '重试', onClick: () => void query.refetch() }}>读取模型服务配置失败</Banner> : query.data && <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); const { apiKey, ...fields } = draft; save.mutate({ ...fields, ...(apiKey?.trim() ? { apiKey } : {}) }); }}>
      <Field label="默认模型"><Input aria-label="默认模型" value={draft.model ?? query.data.model} placeholder="留空沿用 CLI 默认模型" disabled={save.isPending} onChange={event => change({ model: event.target.value })}/></Field>
      <Field label="服务地址"><Input aria-label="服务地址" value={draft.baseUrl ?? query.data.baseUrl} placeholder="https://服务地址（留空沿用 CLI 配置）" disabled={save.isPending} onChange={event => change({ baseUrl: event.target.value })}/></Field>
      <Field label="认证方式"><Select aria-label="认证方式" value={draft.authMode ?? query.data.authMode} disabled={save.isPending} onChange={event => change({ authMode: event.target.value as 'bearer' | 'api-key' })}><option value="bearer">Bearer（中转服务常用）</option><option value="api-key">X-Api-Key（Anthropic API）</option></Select></Field>
      <Field label="API Key"><Input aria-label="API Key" type="password" autoComplete="new-password" value={draft.apiKey ?? ''} placeholder={query.data.hasApiKey ? '已配置；留空保留原密钥' : '输入 API Key'} disabled={save.isPending} onChange={event => change({ apiKey: event.target.value, clearApiKey: false })}/></Field>
      {query.data.hasApiKey && <p>{query.data.apiKeyAvailable ? 'API Key 已配置，密钥不会回显。' : 'API Key 文件不可用，请重新填写。'}</p>}
      <div className="flex gap-2"><Button type="submit" disabled={save.isPending || !Object.keys(draft).length}>{save.isPending ? '保存中…' : '保存模型配置'}</Button>{query.data.hasApiKey && <Button variant="secondary" disabled={save.isPending} onClick={() => save.mutate({ clearApiKey: true })}>清除 API Key</Button>}</div>
    </form>}
    {save.error && <Banner tone="danger">{save.error.message}</Banner>}
    {save.isSuccess && <p role="status" className="mt-2">已保存；下次启动 Agent 进程时生效。</p>}
  </details>;
}
