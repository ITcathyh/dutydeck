import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agentModelSettingsApi, type AgentModelSettingsPatch } from '../api';
import { currentInstance } from '../instance';
import { clearCachedAgentModels } from '../model-cache';
import { Banner, Button, Field, Input, Select, Spinner } from './primitives';

export function AgentModelSettings({ agentId, botAppId, onDirtyChange }: { agentId: string; botAppId?: string; onDirtyChange?: (dirty: boolean, saving?: boolean) => void }) {
  const client = useQueryClient();
  const key = ['agent-model-settings', currentInstance(), agentId, botAppId ?? ''];
  const query = useQuery({ queryKey: key, queryFn: () => botAppId ? agentModelSettingsApi.get(agentId, botAppId) : agentModelSettingsApi.get(agentId), retry: false });
  const [draft, setDraft] = useState<AgentModelSettingsPatch>({});
  const save = useMutation({
    mutationFn: (patch: AgentModelSettingsPatch) => botAppId ? agentModelSettingsApi.set(agentId, patch, botAppId) : agentModelSettingsApi.set(agentId, patch),
    onSuccess: async data => {
      setDraft({});
      client.setQueryData(key, data);
      if (botAppId) await client.invalidateQueries({ queryKey: ['bot-agent-models', botAppId, agentId] });
      else {
        clearCachedAgentModels(agentId);
        client.removeQueries({ queryKey: ['agent-models', agentId] });
        await client.invalidateQueries({ queryKey: ['agents'] });
      }
    }
  });
  const dirty = Object.keys(draft).length > 0;
  useEffect(() => { onDirtyChange?.(dirty || save.isPending, save.isPending); }, [dirty, save.isPending, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const submit = () => { const { apiKey, ...fields } = draft; save.mutate({ ...fields, ...(apiKey?.trim() ? { apiKey } : {}) }); };
  const Form = botAppId ? 'div' : 'form';
  const change = (patch: AgentModelSettingsPatch) => { setDraft(value => ({ ...value, ...patch })); save.reset(); };
  return <details className="mt-3 text-caption text-secondary">
    <summary className="cursor-pointer font-semibold text-primary">模型服务配置</summary>
    <p className="mt-2">{botAppId ? '仅用于这个机器人使用当前 Claude Code Agent 的会话，其他机器人和 Web 会话不受影响。未配置或清除 API Key 后沿用共享 Agent / CLI 连接配置。模型使用机器人的默认模型。请先点击「保存模型配置」，再完成机器人配置。' : '可填写兼容 Claude API 的服务地址和密钥。清除密钥后恢复 CLI 连接配置。'}服务地址需配置 API Key 才会启用；保存后在下次启动 Agent 进程时生效，正在运行的会话可用 /new 重新创建。</p>
    {query.isLoading ? <Spinner/> : query.isError ? <Banner tone="danger" action={{ label: '重试', onClick: () => void query.refetch() }}>读取模型服务配置失败</Banner> : query.data && <Form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); submit(); }}>
      {!botAppId && <Field label="默认模型"><Input aria-label="默认模型" value={draft.model ?? query.data.model} placeholder="留空沿用 CLI 默认模型" disabled={save.isPending} onChange={event => change({ model: event.target.value })}/></Field>}
      <Field label="服务地址"><Input aria-label="服务地址" value={draft.baseUrl ?? query.data.baseUrl} placeholder="https://服务地址（留空沿用 CLI 配置）" disabled={save.isPending} onChange={event => change({ baseUrl: event.target.value })}/></Field>
      <Field label="认证方式"><Select aria-label="认证方式" value={draft.authMode ?? query.data.authMode} disabled={save.isPending} onChange={event => change({ authMode: event.target.value as 'bearer' | 'api-key' })}><option value="bearer">Bearer（中转服务常用）</option><option value="api-key">X-Api-Key（Anthropic API）</option></Select></Field>
      <Field label="API Key"><Input aria-label="API Key" type="password" autoComplete="new-password" value={draft.apiKey ?? ''} placeholder={query.data.hasApiKey ? '已配置；留空保留原密钥' : '输入 API Key'} disabled={save.isPending} onChange={event => change({ apiKey: event.target.value, clearApiKey: false })}/></Field>
      {query.data.hasApiKey && <p>{query.data.apiKeyAvailable ? 'API Key 已配置，密钥不会回显。' : 'API Key 文件不可用，请重新填写。'}</p>}
      <div className="flex gap-2"><Button type={botAppId ? 'button' : 'submit'} onClick={botAppId ? submit : undefined} disabled={save.isPending || !dirty}>{save.isPending ? '保存中…' : '保存模型配置'}</Button>{query.data.hasApiKey && <Button variant="secondary" disabled={save.isPending} onClick={() => save.mutate({ clearApiKey: true })}>清除 API Key</Button>}</div>
    </Form>}
    {botAppId && dirty && <p className="mt-2 text-warning">模型服务配置尚未保存。</p>}
    {save.error && <Banner tone="danger">{save.error.message}</Banner>}
    {save.isSuccess && <p role="status" className="mt-2">已保存；下次启动 Agent 进程时生效。</p>}
  </details>;
}
