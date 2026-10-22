import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PluginBinding, SavePluginBinding } from '@dutydeck/shared';
import { pluginBindingsApi } from '../api';
import { Banner, Button, Card, Field, Input, Select, Spinner } from './primitives';

const empty = (): SavePluginBinding => ({ plugin: '', botAppId: '', enabled: true, config: {}, secrets: {}, skills: [], expectedRevision: 0 });
export function PluginBindingsPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['plugin-bindings'], queryFn: pluginBindingsApi.list });
  const [draft, setDraft] = useState<SavePluginBinding>(empty);
  const [target, setTarget] = useState<'bot' | 'group' | 'workspace'>('bot');
  const selected = query.data?.packages.find(item => item.name === draft.plugin);
  const save = useMutation({ mutationFn: () => pluginBindingsApi.save(draft), onSuccess: async ({ binding }) => { edit(binding); await queryClient.invalidateQueries({ queryKey: ['plugin-bindings'] }); } });
  const preview = useMutation({ mutationFn: () => pluginBindingsApi.explain({ plugin: draft.plugin, botAppId: draft.botAppId, chatId: draft.chatId, cwd: draft.workspaceRoot }) });
  function edit(binding: PluginBinding) {
    const { id: _id, revision, ...input } = binding;
    setDraft({ ...input, expectedRevision: revision });
    setTarget(binding.workspaceRoot ? 'workspace' : binding.chatId ? 'group' : 'bot');
    preview.reset();
  }
  if (query.isPending) return <Spinner />;
  if (query.error) return <Banner tone="danger">{query.error.message}</Banner>;
  return <div className="space-y-4">
    <h2 className="text-title font-semibold">插件与技能</h2>
    <p className="text-caption text-secondary">同一插件可供多个群或项目使用。群绑定优先于 Bot；Web 任务按原项目目录匹配。凭据只填写已有秘密引用，不填写密钥正文。</p>
    {!query.data?.packages.length && <Banner tone="info">尚无已激活的插件。安装并激活插件后可配置绑定。</Banner>}
    {query.data?.packages.map(item => <Card key={item.name} className="p-3"><strong>{item.name}</strong> · {item.version ?? '未声明版本'} · {item.scope}<p className="text-caption">API {item.apiVersion}{item.legacyGlobal.length ? ` · 全局兼容能力：${item.legacyGlobal.join(', ')}` : ''}</p></Card>)}
    {query.data?.diagnostics.map((item, index) => <Banner key={index} tone="danger">{item.plugin}: {item.message}</Banner>)}
    <div className="flex flex-wrap gap-2">{query.data?.bindings.map(binding => <Button key={binding.id} onClick={() => edit(binding)}>{binding.plugin} · {binding.chatId ?? binding.botAppId ?? binding.workspaceRoot} · r{binding.revision}{binding.enabled ? '' : '（停用）'}</Button>)}<Button onClick={() => { setDraft(empty()); setTarget('bot'); preview.reset(); }}>新建绑定</Button></div>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <Field label="插件"><Select aria-label="插件" value={draft.plugin} onChange={event => { setDraft({ ...empty(), plugin: event.target.value }); setTarget('bot'); }}><option value="">选择插件</option>{draft.plugin && !selected && <option value={draft.plugin}>{draft.plugin}（加载失败或未安装）</option>}{query.data?.packages.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</Select></Field>
      <Field label="绑定目标"><Select aria-label="绑定目标" value={target} onChange={event => { const next = event.target.value as typeof target; setTarget(next); setDraft({ ...draft, botAppId: next === 'workspace' ? undefined : '', chatId: next === 'group' ? '' : undefined, workspaceRoot: next === 'workspace' ? '' : undefined, expectedRevision: 0 }); }}><option value="bot">Bot 默认</option><option value="group">指定群</option><option value="workspace">Web 项目目录</option></Select></Field>
      {target === 'workspace' ? <Field label="原项目绝对目录"><Input required aria-label="原项目绝对目录" value={draft.workspaceRoot ?? ''} onChange={event => setDraft({ ...draft, workspaceRoot: event.target.value, expectedRevision: 0 })}/></Field> : <Field label="Bot App ID"><Input required aria-label="Bot App ID" value={draft.botAppId ?? ''} onChange={event => setDraft({ ...draft, botAppId: event.target.value, expectedRevision: 0 })}/></Field>}
      {target === 'group' && <Field label="群 ID"><Input required aria-label="群 ID" value={draft.chatId ?? ''} onChange={event => setDraft({ ...draft, chatId: event.target.value, expectedRevision: 0 })}/></Field>}
      <label className="flex gap-2"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })}/>启用此绑定</label>
      {Object.entries(selected?.configSchema ?? {}).map(([key, field]) => {
        const secret = field.type === 'secret';
        const value = secret ? draft.secrets[key] ?? '' : draft.config[key] ?? field.default ?? '';
        const update = (text: string) => {
          if (!text && field.type !== 'string') { const next = { ...(secret ? draft.secrets : draft.config) }; delete next[key]; setDraft({ ...draft, ...(secret ? { secrets: next as Record<string, string> } : { config: next }) }); return; }
          let parsed: unknown = text;
          if (field.type === 'boolean') parsed = text === 'true';
          else if (field.type === 'number' || field.type === 'integer') parsed = Number(text);
          else if (field.type === 'string_list') parsed = text.split(',').map(item => item.trim()).filter(Boolean);
          setDraft({ ...draft, ...(secret ? { secrets: { ...draft.secrets, [key]: text } } : { config: { ...draft.config, [key]: parsed } }) });
        };
        const choices = field.enum ?? (field.type === 'boolean' ? [true, false] : undefined);
        return <Field key={key} label={`${key}${field.required ? ' *' : ''}${secret ? '（秘密引用）' : ''}`} hint={field.description}>
          {choices ? <Select aria-label={key} value={String(value)} onChange={event => update(event.target.value)}><option value="">请选择</option>{choices.map(item => <option key={String(item)} value={String(item)}>{String(item)}</option>)}</Select> : <Input aria-label={key} required={field.required} value={Array.isArray(value) ? value.join(',') : String(value)} onChange={event => update(event.target.value)}/>}
        </Field>;
      })}
      <Field label="额外必需技能（包名/技能名，以逗号分隔）"><Input aria-label="额外必需技能" value={draft.skills.join(',')} onChange={event => setDraft({ ...draft, skills: event.target.value.split(',').map(value => value.trim()).filter(Boolean) })}/></Field>
      {save.error && <Banner tone="danger">{save.error.message}</Banner>}
      <div className="flex gap-2"><Button type="submit" disabled={(!selected && draft.enabled) || save.isPending}>保存绑定</Button><Button type="button" disabled={!selected || preview.isPending} onClick={() => preview.mutate()}>解释已保存配置</Button></div>
    </form>
    {preview.error && <Banner tone="danger">{preview.error.message}</Banner>}
    {preview.data && <pre className="overflow-auto rounded border border-default p-3 text-caption">{JSON.stringify(preview.data, null, 2)}</pre>}
  </div>;
}
