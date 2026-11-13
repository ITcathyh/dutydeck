import { useQuery } from '@tanstack/react-query';
import type { Agent } from '../api';
import { agentModelsQueryKey, loadAgentModels } from '../model-cache';
import { Field, Input, Select } from './primitives';
import { CompactSelect } from './CompactSelect';

type Values = { replyPolishEnabled: boolean; replyPolishAgentId: string; replyPolishModel: string; replyPolishTimeoutSeconds: string };

export function replyPolishTimeoutValue(seconds: string): number | null {
  if (!seconds.trim()) return null;
  const milliseconds = Number(seconds) * 1000;
  const rounded = Math.round(milliseconds);
  if (!Number.isSafeInteger(rounded) || rounded < 1 || rounded > 2_147_483_647
    || Math.abs(milliseconds - rounded) > Number.EPSILON * Math.max(1, milliseconds) * 4) {
    throw new Error('优化等待时间须为正数，精确到毫秒，并在系统计时器可表示的范围内。');
  }
  return rounded;
}

export function ReplyPolishSettings({ agents, value, onChange, appId }: {
  agents: Agent[]; appId?: string; value: Values; onChange(patch: Partial<Values>): void;
}) {
  const supported = agents.filter(agent => agent.protocol === 'acp');
  const models = useQuery({
    queryKey: agentModelsQueryKey(value.replyPolishAgentId, undefined, appId),
    queryFn: () => loadAgentModels(value.replyPolishAgentId, undefined, false, appId),
    enabled: value.replyPolishEnabled && supported.some(agent => agent.id === value.replyPolishAgentId),
    staleTime: 5 * 60_000
  });
  return <div className="space-y-3 border-t border-subtle pt-4" id="bot-setting-replyPolishEnabled">
    <label className="flex items-center gap-2 text-caption"><input type="checkbox" role="switch" aria-label="文字优化" checked={value.replyPolishEnabled} onChange={event => onChange({ replyPolishEnabled: event.target.checked })}/>文字优化</label>
    <p className="text-caption text-subtle">默认关闭。最终回复交给另一个 Agent 润色，会增加一次模型调用和等待时间；超过设定等待时间、失败或内容校验不通过时发送原文。执行记录保留原文。</p>
    {value.replyPolishEnabled && <div className="grid gap-3 sm:grid-cols-2">
      <Field label="优化 Agent" hint="选择支持只读执行的 ACP Agent，例如 TRAE (ACP)。">
        <Select id="bot-setting-replyPolishAgentId" aria-label="优化 Agent" value={value.replyPolishAgentId} onChange={event => onChange({ replyPolishAgentId: event.target.value, replyPolishModel: '' })}>
          <option value="">请选择优化 Agent</option>
          {supported.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </Select>
      </Field>
      <Field htmlFor="bot-setting-replyPolishModel" label="优化模型" hint="留空使用优化 Agent 自己的默认模型。">
        {models.data?.models.length ? <CompactSelect value={value.replyPolishModel} onChange={replyPolishModel => onChange({ replyPolishModel })} placeholder="选择优化模型" disabledText="" options={[{ value: '', label: '使用优化 Agent 默认模型' }, ...models.data.models.map(model => ({ value: model.id, label: model.name }))]}/>
          : <Input id="bot-setting-replyPolishModel" aria-label="优化模型" value={value.replyPolishModel} onChange={event => onChange({ replyPolishModel: event.target.value })} placeholder="优化 Agent 默认模型"/>}
      </Field>
      <Field htmlFor="bot-setting-replyPolishTimeoutMs" label="优化等待时间（秒）" hint="默认 60 秒，可自行调整；留空恢复默认。关闭文字优化时保留此设置。">
        <Input id="bot-setting-replyPolishTimeoutMs" aria-label="优化等待时间（秒）" type="number" min="0.001" step="0.001" value={value.replyPolishTimeoutSeconds} onChange={event => onChange({ replyPolishTimeoutSeconds: event.target.value })} placeholder="60"/>
      </Field>
    </div>}
  </div>;
}
