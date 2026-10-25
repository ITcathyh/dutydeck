import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agentConfigApi, api, type Agent } from '../api';
import { currentInstance } from '../instance';
import { Banner, Button, Field, Select, Spinner } from './primitives';

export function CodexProfileSettings({ agent, onDirtyChange }: { agent: Agent; onDirtyChange?: (dirty: boolean, saving?: boolean) => void }) {
  const client = useQueryClient();
  const key = ['codex-profile', currentInstance(), agent.id];
  const supported = ['codex', 'codex-cli'].includes(agent.id) && agent.protocol === 'pty-cli';
  const config = useQuery({ queryKey: key, queryFn: () => agentConfigApi.get(agent.id), enabled: supported, retry: false });
  const models = useQuery({ queryKey: ['agent-models', currentInstance(), agent.id], queryFn: () => api.agentModels(agent.id), enabled: supported, retry: false });
  const [draft, setDraft] = useState<string | undefined>();
  const save = useMutation({
    mutationFn: (profile: string | null) => agentConfigApi.set(agent.id, profile),
    onSuccess: async value => { setDraft(undefined); client.setQueryData(key, { id: value.id, codexProfile: value.codexProfile ?? '' }); await client.invalidateQueries({ queryKey: ['agents'] }); }
  });
  const dirty = draft !== undefined;
  useEffect(() => { onDirtyChange?.(dirty || save.isPending, save.isPending); }, [dirty, save.isPending, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  if (!supported) return null;
  const value = draft ?? config.data?.codexProfile ?? agent.codexProfile ?? '';
  const profiles = models.data?.profiles ?? [];
  return <details className="mt-3 text-caption text-secondary">
    <summary className="cursor-pointer font-semibold text-primary">Codex 配置 profile</summary>
    <p className="mt-2">只读取 profile 名称，不读取 config.toml 的模型、凭据或其他值。保存后新建会话生效。</p>
    {config.isLoading || models.isLoading ? <Spinner/> : config.isError || models.isError ? <Banner tone="danger">读取 Codex profile 失败</Banner> : <div className="mt-3 space-y-3">
      <Field label="profile"><Select aria-label="Codex profile" value={value} disabled={save.isPending} onChange={event => { setDraft(event.target.value); save.reset(); }}><option value="">CLI 默认</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</Select></Field>
      <Button variant="secondary" disabled={save.isPending || !dirty} onClick={() => save.mutate(value || null)}>{save.isPending ? '保存中…' : '保存 profile'}</Button>
      {save.error && <Banner tone="danger">{save.error.message}</Banner>}
      {save.isSuccess && <p role="status">已保存；新建 Codex 会话时生效。</p>}
    </div>}
  </details>;
}
