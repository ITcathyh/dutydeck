import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Clock3, ShieldAlert, X } from 'lucide-react';
import { ApiError, scheduleApi, type PublicScheduleDefinition, type ScheduleDetail } from '../api';
import { Badge, Banner, Button, Card, Dialog, EmptyState, Field, IconButton, Input, Select, Spinner } from './primitives';

type Draft = Pick<PublicScheduleDefinition, 'id' | 'revision' | 'name' | 'timezone' | 'dstPolicy' | 'state'>;

function triggerLabel(schedule: PublicScheduleDefinition): string {
  if (schedule.trigger.kind === 'at') return `单次 · ${schedule.trigger.localDateTime}`;
  if (schedule.trigger.kind === 'interval') return `每 ${schedule.trigger.everySeconds} 秒 · 锚点 ${schedule.trigger.anchorAt}`;
  return `Cron · ${schedule.trigger.expression}`;
}

function occurrenceLabel(value?: { scheduledForUtc: string; localLabel: string; timezone: string; dstResolution: string }): string {
  return value ? `${value.localLabel} (${value.timezone}) · ${value.scheduledForUtc} · ${value.dstResolution}` : '当前定义没有可预览的下一次触发';
}

export function ScheduleFoundationPanel({ open, onClose }: { open: boolean; onClose(): void }) {
  const queryClient = useQueryClient();
  const capabilities = useQuery({ queryKey: ['schedule-capabilities'], queryFn: scheduleApi.capabilities, enabled: open, retry: false });
  const schedules = useQuery({ queryKey: ['schedule-foundation-list'], queryFn: scheduleApi.list, enabled: open && capabilities.data?.repositoriesWired === true, retry: false });
  const channelBotIds = useMemo(() => [...new Set((schedules.data?.schedules ?? []).map(item => item.definition.channelBotId))], [schedules.data]);
  const integrationQueries = useQueries({
    queries: channelBotIds.map(channelBotId => ({
      queryKey: ['schedule-archived-integrations', channelBotId],
      queryFn: () => scheduleApi.archivedIntegrations(channelBotId),
      enabled: open,
      retry: false
    }))
  });
  const archivedIntegrations = integrationQueries.flatMap(query => query.data?.integrations ?? []);
  const [draft, setDraft] = useState<Draft>();
  const [conflict, setConflict] = useState<ScheduleDetail>();
  const [previewById, setPreviewById] = useState<Record<string, Awaited<ReturnType<typeof scheduleApi.preview>>>>({});
  const preview = useMutation({
    mutationFn: (id: string) => scheduleApi.preview(id),
    onSuccess: value => setPreviewById(current => ({ ...current, [value.scheduleId]: value }))
  });
  const save = useMutation({
    mutationFn: (current: Draft) => scheduleApi.update(current.id, {
      expectedRevision: current.revision,
      name: current.name,
      timezone: current.timezone,
      dstPolicy: current.dstPolicy,
      state: current.state
    }),
    onSuccess: async () => { setDraft(undefined); setConflict(undefined); await queryClient.invalidateQueries({ queryKey: ['schedule-foundation-list'] }); },
    onError: error => {
      if (error instanceof ApiError && error.code === 'SCHEDULE_REVISION_CONFLICT' && error.current) setConflict(error.current as ScheduleDetail);
    }
  });
  useEffect(() => {
    if (!open) { setDraft(undefined); setConflict(undefined); setPreviewById({}); save.reset(); preview.reset(); }
  }, [open]);
  const capability = capabilities.data;
  const visibleCapabilityBlockers = capability?.blockers.filter(blocker => blocker.code !== 'schedule_ui_entry_unwired') ?? [];
  // 写操作在路上时不允许 Escape / 点遮罩关闭（契约 §8.1）：CAS 保存丢在半路会让用户
  // 无从知道 revision 到底推没推上去。preview 同理——转圈时关掉面板，结果无处可落。
  const busy = save.isPending || preview.isPending;

  return <Dialog open={open} onClose={onClose} label="Schedule 离线管理" size="lg" closeOnEscape={!busy} closeOnScrim={!busy}>
    <Dialog.Header>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-queued-soft text-queued"><CalendarClock size={18}/></span>
      <div className="min-w-0 flex-1">
        <div className="text-meta font-semibold uppercase tracking-[.12em] text-queued">Offline management · edit / preview only</div>
        <h2 className="mt-1 text-title font-semibold text-primary">Schedule 定义与触发预览</h2>
        <p className="mt-1 text-caption text-subtle">只能维护 staged/disabled 定义；不会启动 timer、创建真实 Run 或接管 Botmux schedule。</p>
      </div>
      <IconButton label="关闭 Schedule 管理" onClick={onClose}><X size={16}/></IconButton>
    </Dialog.Header>
    <Dialog.Body className="p-5">
      {capabilities.isLoading && <div className="flex min-h-40 items-center justify-center"><Spinner label="正在读取 Schedule 管理能力…"/></div>}
      {capabilities.isError && <Banner tone="danger">Schedule 能力读取失败：{capabilities.error.message}</Banner>}
      {capability && <Banner tone="warning" title={<span className="inline-flex items-center gap-2"><ShieldAlert size={15}/>执行器保持不可用</span>}>
        <p>当前仅提供离线定义、CAS 编辑和下一次触发预览；控制中心入口已就绪。</p>
        <div className="mt-2 flex flex-wrap gap-2">{visibleCapabilityBlockers.map(blocker => <span key={blocker.code} title={blocker.action}><Badge tone="warning">{blocker.code}</Badge></span>)}</div>
      </Banner>}
      {capability?.repositoriesWired === false && <EmptyState tone="neutral" icon={<CalendarClock size={22}/>} title="Schedule v13 仓储尚未注入" description="服务会返回 machine-readable `SCHEDULE_REPOSITORY_UNWIRED`；不会降级成内存执行。"/>}
      {capability && !capability.permissionEvaluatorWired && <div className="mt-3"><Banner tone="danger" title="编辑已禁用">缺少 owner/admin permission evaluator。</Banner></div>}
      {schedules.isLoading && <div className="mt-4 flex justify-center"><Spinner label="正在加载 Schedule 定义…"/></div>}
      {schedules.isError && <div className="mt-4"><Banner tone="danger">Schedule 列表读取失败：{schedules.error.message}</Banner></div>}
      {schedules.data?.schedules.length === 0 && <EmptyState tone="neutral" title="尚无 staged/disabled ScheduleDefinition。"/>}
      <div className="mt-4 space-y-3">{schedules.data?.schedules.map(item => {
        const definition = item.definition;
        const shownPreview = previewById[definition.id]?.preview ?? item.readiness.nextOccurrence;
        return <Card key={definition.id} as="article" padding="md">
          <div className="flex flex-wrap items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-queued-soft text-queued"><Clock3 size={16}/></span><div className="min-w-0 flex-1"><h3 className="text-body font-semibold text-primary">{definition.name}</h3><p className="mt-1 text-caption text-subtle">{triggerLabel(definition)} · generation {definition.currentGeneration} · revision {definition.revision}</p></div><Badge>{definition.sourceOwnership} source · {definition.state}/disabled</Badge></div>
          <div className="mt-3 rounded-md bg-muted px-3 py-2 text-caption text-secondary"><strong>下一次触发：</strong>{occurrenceLabel(shownPreview)}</div>
          <div className="mt-3 space-y-1.5">{item.readiness.blockers.map(blocker => <div key={blocker.code} className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-caption text-warning"><AlertTriangle size={13} className="mt-1 shrink-0"/><span><strong>{blocker.code}</strong> · {blocker.action}</span></div>)}</div>
          <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" loading={preview.isPending} onClick={() => preview.mutate(definition.id)}>预览下一次触发</Button><Button variant="secondary" disabled={!capability?.writesEnabled} onClick={() => setDraft({ id: definition.id, revision: definition.revision, name: definition.name, timezone: definition.timezone, dstPolicy: definition.dstPolicy, state: definition.state })}>编辑禁用态定义</Button></div>
        </Card>;
      })}</div>
      {archivedIntegrations.length > 0 && <section className="mt-5"><h3 className="text-body font-semibold text-primary">归档集成</h3><div className="mt-2 grid gap-3 sm:grid-cols-2">{archivedIntegrations.map(integration => <article key={integration.id} className="rounded-lg border border-queued-border bg-queued-soft p-4 text-caption text-queued"><div className="font-semibold">Hammer · typed archived metadata</div><div className="mt-2">source {integration.sourceEnabled ? 'enabled' : 'disabled'} · mode {integration.mode} · gates {integration.enforceGates ? 'enforced' : 'off'} · skills {integration.skillsInjection}</div><div className="mt-2 font-semibold">{integration.blockerCode} · 尚未承接执行器</div></article>)}</div></section>}
    </Dialog.Body>
    {/*
      编辑条是钉在底部、不随 Body 滚动的多行网格，所以借 Dialog.Footer 的
      shrink-0 + 顶边 + muted 底，但把它的单行 justify-end 布局覆盖成纵向堆叠。
    */}
    {draft && <Dialog.Footer className="flex-col items-stretch justify-start gap-0 py-4">
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate(draft); }}>
        <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><h3 className="text-body font-semibold text-primary">编辑 ScheduleDefinition</h3><p className="mt-0.5 text-meta text-subtle">基于 revision {draft.revision}；保存后生成新的 pinned generation，但仍为 disabled。</p></div><Button variant="ghost" onClick={() => { setDraft(undefined); setConflict(undefined); }}>取消</Button></div>
        {conflict && <div className="mt-3"><Banner tone="warning" title="定义已被其他修改更新。">当前版本是 revision {conflict.definition.revision}；名称、时区和 DST 草稿仍保留。<button type="button" onClick={() => { setDraft(current => current ? { ...current, revision: conflict.definition.revision } : current); setConflict(undefined); save.reset(); }} className="ml-2 font-semibold underline">基于新版本重试</button></Banner></div>}
        {save.error && !conflict && <div className="mt-3"><Banner tone="danger">{`保存失败：${save.error.message}`}</Banner></div>}
        {/*
          显式 aria-label 覆盖 Field 的可见 label：可访问名保持「Schedule 名称」/
          「Schedule 时区」（可见文案只有「名称」「时区」，在一屏多控件时不足以区分）。
          两个 select 原本连 label 都没有，接上 Field 后可访问名从无到有。
        */}
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2"><Field label="名称"><Input aria-label="Schedule 名称" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></Field></div>
          <Field label="时区"><Input aria-label="Schedule 时区" value={draft.timezone} onChange={event => setDraft({ ...draft, timezone: event.target.value })}/></Field>
          <Field label="DST gap"><Select value={draft.dstPolicy.gap} onChange={event => setDraft({ ...draft, dstPolicy: { ...draft.dstPolicy, gap: event.target.value as Draft['dstPolicy']['gap'] } })}><option value="skip">skip</option><option value="shift_forward">shift_forward</option></Select></Field>
          <Field label="DST overlap"><Select value={draft.dstPolicy.overlap} onChange={event => setDraft({ ...draft, dstPolicy: { ...draft.dstPolicy, overlap: event.target.value as Draft['dstPolicy']['overlap'] } })}><option value="first">first</option><option value="second">second</option></Select></Field>
        </div>
        <div className="mt-3 flex justify-end"><Button type="submit" variant="primary" loading={save.isPending} disabled={!capability?.writesEnabled || !draft.name.trim()}>{save.isPending ? '保存中…' : '保存 staged/disabled 定义'}</Button></div>
      </form>
    </Dialog.Footer>}
  </Dialog>;
}
