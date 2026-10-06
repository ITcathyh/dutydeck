import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { ApiError, collaborationApi, type CollaborationDuty, type UpdateCollaborationDutyInput } from '../api';
import { Banner, Button, Field, Input, Select } from './primitives';

type Responder = 'none' | 'self' | 'other';
type Draft = { responder: Responder; enabled: boolean; sources: string; levels: string; dedupeHours: number; maxPerHour: number };

const words = (text: string) => [...new Set(text.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean))];
const clamp = (value: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(value)) || min));

function draftOf(duty: CollaborationDuty, appId: string): Draft {
  return {
    responder: !duty.responder ? 'none' : duty.responder.appId === appId ? 'self' : 'other',
    enabled: duty.alarm?.enabled ?? false,
    sources: duty.alarm?.sources.map(source => source.appId).join(', ') ?? '',
    levels: duty.alarm?.levels.join(', ') ?? '',
    dedupeHours: duty.alarm?.dedupeHours ?? 6,
    maxPerHour: duty.alarm?.maxPerHour ?? 3
  };
}

/** 群设置里的分工：接话人和告警初筛订阅。只提交改动的那一项。 */
export function GroupDutySettings({ appId, chatId, botName, duty, onSaved }: { appId: string; chatId: string; botName?: string; duty: CollaborationDuty; onSaved(): Promise<unknown> }) {
  const saved = draftOf(duty, appId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const value = draft ?? saved;
  const update = (patch: Partial<Draft>) => { setDraft({ ...value, ...patch }); setNotice(null); };
  const alarmChanged = (['enabled', 'sources', 'levels', 'dedupeHours', 'maxPerHour'] as const).some(key => value[key] !== saved[key]);
  const responderChanged = value.responder !== saved.responder;
  const sources = words(value.sources);
  const missingSource = value.enabled && !sources.length;
  const other = duty.responder && duty.responder.appId !== appId ? duty.responder : undefined;

  const save = useMutation({
    mutationFn: () => {
      const body: UpdateCollaborationDutyInput = { expectedRevision: duty.revision };
      if (responderChanged) body.responder = value.responder === 'self' ? 'self' : null;
      // 来源名字只用于展示，沿用已有订阅里的。
      const names = new Map(duty.alarm?.sources.map(source => [source.appId, source.name]));
      if (alarmChanged) body.alarm = { enabled: value.enabled, levels: words(value.levels), dedupeHours: value.dedupeHours, maxPerHour: value.maxPerHour,
        sources: sources.map(id => { const name = names.get(id); return { appId: id, ...(name ? { name } : {}) }; }) };
      return collaborationApi.updateDuty(appId, chatId, body);
    },
    onSuccess: async result => {
      setDraft(null);
      setError(null);
      setNotice(result.announced === false
        ? { tone: 'warning', text: `已保存，但群里的接话人声明没发出去，其他机器人可能还不知道。${result.duty.responder
          ? '可以在群里 @本 Bot 说「你负责接话」重发声明。' : '需要别的机器人接时，在群里 @它 说「你负责接话」。'}` }
        : { tone: 'success', text: '群分工已保存。' });
      await onSaved();
    },
    onError: failure => setError(failure instanceof ApiError && failure.code === 'COLLABORATION_REVISION_CONFLICT'
      ? '群分工已被修改，请放弃修改后重新编辑。' : failure instanceof Error ? failure.message : '保存失败')
  });

  return (
    <div className="space-y-4 rounded-lg border border-subtle p-4">
      <div className="text-body font-semibold text-primary">群分工</div>
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner>}
      <Field label="接话人" hint="群里有多个机器人时，没 @ 机器人的消息只由接话人接，其他机器人只接 @ 和自己接手的话题。设成本 Bot 或取消时，本 Bot 会在群里发一条声明，其他 Dutydeck 机器人据此同步。">
        <Select value={value.responder} onChange={e => update({ responder: e.target.value as Responder })}>
          <option value="none">未指定</option>
          <option value="self">本 Bot{botName ? `（${botName}）` : ''}</option>
          {other && <option value="other" disabled>{other.name ?? other.appId}（另一个机器人，在群里声明的）</option>}
        </Select>
      </Field>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-default text-action focus:ring-action"
          checked={value.enabled}
          disabled={!duty.alarm?.requesterId && !value.enabled}
          onChange={e => update({ enabled: e.target.checked })}
        />
        <span>
          <span className="block text-caption font-semibold text-primary">告警初筛</span>
          <span className="mt-1 block text-meta text-subtle">
            {duty.alarm?.requesterId
              ? `来源机器人发的告警命中后，在告警话题里起初筛任务，以在群里确认订阅的人（${duty.alarm.requesterId}）的名义发起。`
              : '开启前先在群里 @机器人 说「告警来了先帮我看看」并点确认：初筛任务要以确认人的名义发起。确认后可以在这里改来源和级别。'}
          </span>
        </span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="来源机器人 app_id" hint="多个用逗号分隔，只有这些机器人发的消息会初筛。" {...(missingSource ? { error: '开启时至少填一个来源' } : {})}>
          <Input value={value.sources} onChange={e => update({ sources: e.target.value })} placeholder="cli_xxx" />
        </Field>
        <Field label="级别关键字" hint="例如 P0, P1；留空表示不限级别。">
          <Input value={value.levels} onChange={e => update({ levels: e.target.value })} />
        </Field>
        <Field label="去重窗口（小时，1–168）">
          <Input type="number" min={1} max={168} className="w-32" value={value.dedupeHours} onChange={e => update({ dedupeHours: clamp(e.target.value, 1, 168) })} />
        </Field>
        <Field label="每小时最多初筛（1–30）">
          <Input type="number" min={1} max={30} className="w-32" value={value.maxPerHour} onChange={e => update({ maxPerHour: clamp(e.target.value, 1, 30) })} />
        </Field>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" disabled={!draft || save.isPending} onClick={() => { setDraft(null); setError(null); }}>放弃修改</Button>
        <Button variant="primary" disabled={!(responderChanged || alarmChanged) || missingSource} loading={save.isPending} onClick={() => save.mutate()}>
          <Check size={14} className="mr-1.5" />
          保存分工
        </Button>
      </div>
    </div>
  );
}
