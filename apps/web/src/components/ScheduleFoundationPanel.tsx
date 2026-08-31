import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Clock3, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { ApiError, scheduleApi, type PublicScheduleDefinition, type ScheduleDetail } from '../api';
import { IconButton } from './ui';

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
  if (!open) return null;
  const capability = capabilities.data;
  const visibleCapabilityBlockers = capability?.blockers.filter(blocker => blocker.code !== 'schedule_ui_entry_unwired') ?? [];
  return <div className="ui-overlay fixed inset-0 z-30 grid place-items-center bg-slate-950/45 p-3 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <section role="dialog" aria-label="Schedule 离线管理" className="flex max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-[var(--paper)] shadow-[0_30px_100px_rgba(15,23,42,.32)]">
      <header className="flex items-start gap-3 border-b border-slate-200 px-5 py-4"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-700"><CalendarClock size={18}/></span><div className="min-w-0 flex-1"><div className="text-[10px] font-semibold uppercase tracking-[.12em] text-indigo-700">Offline management · edit / preview only</div><h2 className="mt-1 text-base font-semibold text-slate-900">Schedule 定义与触发预览</h2><p className="mt-1 text-xs text-slate-500">只能维护 staged/disabled 定义；不会启动 timer、创建真实 Run 或接管 Botmux schedule。</p></div><IconButton label="关闭 Schedule 管理" onClick={onClose}><X size={16}/></IconButton></header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {capabilities.isLoading && <div role="status" className="flex min-h-40 items-center justify-center text-sm text-slate-500"><RefreshCw size={15} className="mr-2 animate-spin"/>正在读取 Schedule 管理能力…</div>}
        {capabilities.isError && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">Schedule 能力读取失败：{capabilities.error.message}</div>}
        {capability && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="flex items-center gap-2 text-sm font-semibold text-amber-950"><ShieldAlert size={15}/>执行器保持不可用</div><p className="mt-1 text-xs leading-5 text-amber-800">当前仅提供离线定义、CAS 编辑和下一次触发预览；控制中心入口已就绪。</p><div className="mt-2 flex flex-wrap gap-2">{visibleCapabilityBlockers.map(blocker => <span key={blocker.code} title={blocker.action} className="rounded-full bg-white/70 px-2 py-1 text-[10px] font-medium text-amber-800">{blocker.code}</span>)}</div></div>}
        {capability?.repositoriesWired === false && <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-center"><CalendarClock size={22} className="mx-auto text-slate-400"/><h3 className="mt-3 text-sm font-semibold text-slate-800">Schedule v13 仓储尚未注入</h3><p className="mt-1 text-xs text-slate-500">服务会返回 machine-readable `SCHEDULE_REPOSITORY_UNWIRED`；不会降级成内存执行。</p></div>}
        {capability && !capability.permissionEvaluatorWired && <div role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800"><strong>编辑已禁用：</strong>缺少 owner/admin permission evaluator。</div>}
        {schedules.isLoading && <div role="status" className="mt-4 text-center text-sm text-slate-500">正在加载 Schedule 定义…</div>}
        {schedules.isError && <div role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">Schedule 列表读取失败：{schedules.error.message}</div>}
        {schedules.data?.schedules.length === 0 && <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">尚无 staged/disabled ScheduleDefinition。</div>}
        <div className="mt-4 space-y-3">{schedules.data?.schedules.map(item => {
          const definition = item.definition;
          const shownPreview = previewById[definition.id]?.preview ?? item.readiness.nextOccurrence;
          return <article key={definition.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex flex-wrap items-start gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-indigo-50 text-indigo-700"><Clock3 size={16}/></span><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-slate-900">{definition.name}</h3><p className="mt-1 text-xs text-slate-500">{triggerLabel(definition)} · generation {definition.currentGeneration} · revision {definition.revision}</p></div><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600">{definition.sourceOwnership} source · {definition.state}/disabled</span></div>
            <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700"><strong>下一次触发：</strong>{occurrenceLabel(shownPreview)}</div>
            <div className="mt-3 space-y-1.5">{item.readiness.blockers.map(blocker => <div key={blocker.code} className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-800"><AlertTriangle size={13} className="mt-0.5 shrink-0"/><span><strong>{blocker.code}</strong> · {blocker.action}</span></div>)}</div>
            <div className="mt-3 flex justify-end gap-2"><button type="button" onClick={() => preview.mutate(definition.id)} disabled={preview.isPending} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-45">预览下一次触发</button><button type="button" onClick={() => setDraft({ id: definition.id, revision: definition.revision, name: definition.name, timezone: definition.timezone, dstPolicy: definition.dstPolicy, state: definition.state })} disabled={!capability?.writesEnabled} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-45">编辑禁用态定义</button></div>
          </article>;
        })}</div>
        {archivedIntegrations.length > 0 && <section className="mt-5"><h3 className="text-sm font-semibold text-slate-900">归档集成</h3><div className="mt-2 grid gap-3 sm:grid-cols-2">{archivedIntegrations.map(integration => <article key={integration.id} className="rounded-xl border border-violet-200 bg-violet-50 p-4 text-xs text-violet-900"><div className="font-semibold">Hammer · typed archived metadata</div><div className="mt-2 leading-5">source {integration.sourceEnabled ? 'enabled' : 'disabled'} · mode {integration.mode} · gates {integration.enforceGates ? 'enforced' : 'off'} · skills {integration.skillsInjection}</div><div className="mt-2 font-semibold">{integration.blockerCode} · 尚未承接执行器</div></article>)}</div></section>}
      </div>
      {draft && <form onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate(draft); }} className="border-t border-slate-200 bg-white px-5 py-4"><div className="flex items-start"><div><h3 className="text-sm font-semibold text-slate-900">编辑 ScheduleDefinition</h3><p className="mt-0.5 text-[11px] text-slate-500">基于 revision {draft.revision}；保存后生成新的 pinned generation，但仍为 disabled。</p></div><button type="button" onClick={() => { setDraft(undefined); setConflict(undefined); }} className="ml-auto text-xs text-slate-500">取消</button></div>
        {conflict && <div role="alert" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900"><strong>定义已被其他修改更新。</strong>当前版本是 revision {conflict.definition.revision}；名称、时区和 DST 草稿仍保留。<button type="button" onClick={() => { setDraft(current => current ? { ...current, revision: conflict.definition.revision } : current); setConflict(undefined); save.reset(); }} className="ml-2 font-semibold underline">基于新版本重试</button></div>}
        {save.error && !conflict && <div role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{`保存失败：${save.error.message}`}</div>}
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><label className="text-xs text-slate-600 lg:col-span-2"><span>名称</span><input aria-label="Schedule 名称" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} className="mt-1 h-9 w-full rounded-lg border border-slate-300 px-2"/></label><label className="text-xs text-slate-600"><span>时区</span><input aria-label="Schedule 时区" value={draft.timezone} onChange={event => setDraft({ ...draft, timezone: event.target.value })} className="mt-1 h-9 w-full rounded-lg border border-slate-300 px-2"/></label><label className="text-xs text-slate-600"><span>DST gap</span><select value={draft.dstPolicy.gap} onChange={event => setDraft({ ...draft, dstPolicy: { ...draft.dstPolicy, gap: event.target.value as Draft['dstPolicy']['gap'] } })} className="mt-1 h-9 w-full rounded-lg border border-slate-300 px-2"><option value="skip">skip</option><option value="shift_forward">shift_forward</option></select></label><label className="text-xs text-slate-600"><span>DST overlap</span><select value={draft.dstPolicy.overlap} onChange={event => setDraft({ ...draft, dstPolicy: { ...draft.dstPolicy, overlap: event.target.value as Draft['dstPolicy']['overlap'] } })} className="mt-1 h-9 w-full rounded-lg border border-slate-300 px-2"><option value="first">first</option><option value="second">second</option></select></label></div>
        <div className="mt-3 flex justify-end"><button type="submit" disabled={save.isPending || !capability?.writesEnabled || !draft.name.trim()} className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">{save.isPending ? '保存中…' : '保存 staged/disabled 定义'}</button></div>
      </form>}
    </section>
  </div>;
}
