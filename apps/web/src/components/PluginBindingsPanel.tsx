import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PluginBinding, SavePluginBinding } from '@dutydeck/shared';
import { pluginBindingsApi } from '../api';
import { ConfigurationSources } from './ConfigurationExplanationPanel';
import { Banner, Button, Card, Field, Input, Select, Spinner } from './primitives';

const empty = (): SavePluginBinding => ({ plugin: '', botAppId: '', enabled: true, config: {}, secrets: {}, skills: [], expectedRevision: 0 });

function PluginSlotPreview({ slot }: { slot: { id: string; slot: string; title: string; description?: string; elements: Array<Record<string, unknown>> } }) {
  return <section className="mt-3 rounded border border-default p-3" aria-label={`${slot.title}（${slot.slot}）`}>
    <div className="font-medium">{slot.title}</div>
    {slot.description && <p className="text-caption text-secondary">{slot.description}</p>}
    <div className="mt-2 space-y-2">
      {slot.elements.map((element, index) => {
        const kind = typeof element.kind === 'string' ? element.kind : 'unknown';
        if (kind === 'text') return <p key={index} className="text-caption">{typeof element.label === 'string' && <strong>{element.label}： </strong>}{typeof element.text === 'string' ? element.text : ''}</p>;
        if (kind === 'status') return <p key={index} role="status" className="text-caption"><strong>{typeof element.label === 'string' ? element.label : '状态'}： </strong>{typeof element.value === 'string' ? element.value : ''}</p>;
        if (kind === 'table') {
          const columns = Array.isArray(element.columns) ? element.columns.filter((value): value is string => typeof value === 'string') : [];
          const rows = Array.isArray(element.rows) ? element.rows.filter((row): row is string[] => Array.isArray(row) && row.every(value => typeof value === 'string')) : [];
          return <table key={index} className="w-full text-caption"><thead><tr>{columns.map(column => <th key={column} className="px-2 py-1 text-left">{column}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((value, valueIndex) => <td key={valueIndex} className="border-t border-default px-2 py-1">{value}</td>)}</tr>)}</tbody></table>;
        }
        if (kind === 'action') {
          const target = element.target && typeof element.target === 'object' ? element.target as Record<string, unknown> : {};
          const targetText = target.kind === 'command' && typeof target.command === 'string' ? `命令：${target.command}` : target.kind === 'tool' && typeof target.tool === 'string' ? `工具：${target.tool}` : '目标未声明';
          return <div key={index} className="flex items-center gap-2"><Button type="button" disabled title="插件动作需要在任务上下文中执行">{typeof element.label === 'string' ? element.label : '插件动作'}</Button><span className="text-caption text-secondary">{targetText} · 受限预览</span></div>;
        }
        return null;
      })}
    </div>
  </section>;
}

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
    {query.data?.packages.map(item => <Card key={item.name} className="p-3"><strong>{item.name}</strong> · {item.version ?? '未声明版本'} · {item.scope}<p className="text-caption">API {item.apiVersion}{item.legacyGlobal.length ? ` · 全局兼容能力：${item.legacyGlobal.join(', ')}` : ''}</p>{item.capabilities?.length ? <p className="text-caption">能力：{item.capabilities.join('、')}</p> : null}{item.permissions && <p className="text-caption">权限足迹：{[...item.permissions.effects, ...item.permissions.network.map(value => `network:${value}`), ...item.permissions.filesystem.map(value => `fs:${value}`)].join('、') || '无'}</p>}{item.slots?.length ? <><p className="text-caption">Web 插槽（受限预览）：{item.slots.map(slot => `${slot.slot}:${slot.id}`).join('、')}</p>{item.slots.map(slot => <PluginSlotPreview key={`${slot.slot}:${slot.id}`} slot={slot}/>)}</> : null}{item.service && <p className="text-caption">服务：{item.service.mode} · {item.service.status.status}</p>}</Card>)}
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
    {preview.data && <ConfigurationSources explanation={{ sessionId: '', observedAt: '', tasks: [], sections: [{ phase: 'saved', title: '已保存插件配置来源', note: '查询时预览；每次工具调用重新解析并授权。完整会话与历史证据见任务详情的“配置来源”。配置和密钥正文不展示。', fields: (() => {
      const binding = preview.data.binding as { id: string; revision: number; config: Record<string, unknown>; secretKeys: string[] } | null;
      return binding ? [
        { key: 'binding', label: '选中的绑定', value: binding.id, status: 'recorded' as const, source: '原插件绑定解析器', revision: binding.revision },
        { key: 'config', label: '已解析配置字段', value: Object.keys(binding.config).join('、') || '无', status: 'recorded' as const, source: '原插件绑定解析器' },
        { key: 'secrets', label: '密钥字段', value: binding.secretKeys.join('、') || '无', status: 'recorded' as const, source: '秘密引用（正文不展示）' },
        { key: 'skills', label: '必需技能请求', value: ((preview.data.skills ?? []) as Array<{ ref: string }>).map(item => item.ref).join('、') || '无', status: 'recorded' as const, source: '绑定与插件声明（不等于已注入）' }
      ] : [{ key: 'binding', label: '选中的绑定', status: 'unset' as const, source: '原插件绑定解析器' }];
    })() }] }}/>}

  </div>;
}
