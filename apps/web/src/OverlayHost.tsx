import { queryKeys } from './queries';
import { lazy, Suspense, type ComponentProps } from 'react';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { api, Agent, LarkConfig, RunSummary, Session } from './api';
import type { useAppLocation } from './app-location';
import { LazyBoundary } from './components/ErrorBoundary';
import { Dialog, IconButton, Spinner } from './components/primitives';
import { SessionTraceView } from './components/SessionTraceView';

const ControlCenterModal = lazy(() => import('./components/ControlCenterModal').then(module => ({ default: module.ControlCenterModal })));
const LarkConfigModal = lazy(() => import('./components/LarkConfigModal').then(module => ({ default: module.LarkConfigModal })));
const GroupPolicyModal = lazy(() => import('./components/GroupPolicyModal').then(module => ({ default: module.GroupPolicyModal })));
export const AutomationOverview = lazy(() => import('./components/AutomationOverview').then(module => ({ default: module.AutomationOverview })));
const UsageOverview = lazy(() => import('./components/UsageOverview').then(module => ({ default: module.UsageOverview })));
const SessionInsightPanel = lazy(() => import('./components/SessionInsightPanel').then(module => ({ default: module.SessionInsightPanel })));
const WorkspaceGroupsModal = lazy(() => import('./components/WorkspaceGroupsModal').then(module => ({ default: module.WorkspaceGroupsModal })));

type OverlayHostProps = {
  location: ReturnType<typeof useAppLocation>;
  agents: Agent[];
  larkConfig: UseQueryResult<LarkConfig>;
  capabilities?: Awaited<ReturnType<typeof api.systemCapabilities>>;
  authRequired?: boolean;
  visibleSessions: Session[];
  runSummaries: Record<string, RunSummary>;
  applySessionSelection(id: string): void;
  openCreateTaskForAgent(agentId?: string): void;
  trace?: Omit<ComponentProps<typeof SessionTraceView>, 'onClose'>;
  workspaceGroupsOpen: boolean;
  closeWorkspaceGroups(): void;
  workspaceGroups: UseQueryResult<Awaited<ReturnType<typeof api.workspaceGroups>>>;
};

export function OverlayHost({
  location, agents, larkConfig, capabilities, authRequired, visibleSessions, runSummaries,
  applySessionSelection, openCreateTaskForAgent, trace, workspaceGroupsOpen, closeWorkspaceGroups, workspaceGroups
}: OverlayHostProps) {
  const { route, overlay, primaryNav, selectedAppId, selectedChatId, navigate, openOverlay,
    closeOverlay, registerSettingsLeaveGuard, openSettings, openLarkSetup } = location;
  const qc = useQueryClient();
  // 四个懒加载浮层的加载态是同一件事，只有文案不同。
  const overlayFallback = (label: string) => <div className="fixed inset-0 z-dialog grid place-items-center bg-scrim backdrop-blur-sm"><Spinner label={label}/></div>;
  return <>
    {overlay?.kind === 'lark-setup' && <Suspense fallback={overlayFallback('正在打开 Bot 绑定向导…')}><LarkConfigModal key={overlay.target === 'new' ? 'new' : overlay.target?.appId ?? 'manage'} target={overlay.target} field={overlay.field} onLeaveGuardChange={registerSettingsLeaveGuard} agents={agents} onClose={() => { closeOverlay(); void qc.invalidateQueries({ queryKey: queryKeys.larkConfig() }); }}/></Suspense>}
    {overlay?.kind === 'settings' && <Suspense fallback={overlayFallback('正在打开设置与接入…')}><ControlCenterModal open onLeaveGuardChange={registerSettingsLeaveGuard} initialSection={overlay.section} field={overlay.field} agents={agents} legacyBots={larkConfig.data?.bots ?? []} larkListeningDisabled={larkConfig.data?.listeningDisabled ?? false} larkBotsLoading={larkConfig.isLoading} larkBotsFailed={larkConfig.isError} larkBotsRetrying={larkConfig.isFetching} onRetryLarkBots={() => void larkConfig.refetch()} authRequired={authRequired} onClose={closeOverlay} onCreateTask={agentId => { closeOverlay(); openCreateTaskForAgent(agentId); }} onOpenLarkSetup={openLarkSetup} onOpenGroups={() => openOverlay({ kind: 'groups' })} onOpenSchedules={() => openOverlay({ kind: 'automation' })}/></Suspense>}
    {overlay?.kind === 'groups' && <Suspense fallback={overlayFallback('正在打开群配置…')}><GroupPolicyModal open onClose={closeOverlay}/></Suspense>}
    {overlay?.kind === 'automation' && <Dialog open onClose={closeOverlay} label="任务自动化" size="lg">
      <Dialog.Header><h2 className="text-title font-semibold">任务自动化</h2><span className="ml-auto"><IconButton label="关闭自动化" onClick={closeOverlay}><X size={16}/></IconButton></span></Dialog.Header>
      <Dialog.Body><LazyBoundary fallback={<Spinner label="正在读取任务自动化…"/>}><AutomationOverview agents={agents} capabilities={capabilities} onOpenAgentSetup={() => openSettings('agents')} sessions={visibleSessions} summaries={runSummaries} onSelectSession={id => { applySessionSelection(id); navigate({ route: { kind: 'session', sessionId: id }, nav: 'tasks', appId: selectedAppId, chatId: selectedChatId }, { replace: true }); }}/></LazyBoundary></Dialog.Body>
    </Dialog>}
    {overlay?.kind === 'usage' && <Dialog open onClose={closeOverlay} label="用量与成本" size="lg">
      <Dialog.Header><h2 className="text-title font-semibold">用量与成本</h2><span className="ml-auto"><IconButton label="关闭用量与成本" onClick={closeOverlay}><X size={16}/></IconButton></span></Dialog.Header>
      <Dialog.Body><LazyBoundary fallback={<Spinner label="正在读取用量…"/>}><UsageOverview
        bots={larkConfig.data?.bots ?? []}
        initialView={overlay.view === 'insight' ? 'insight' : 'cost'}
        onViewChange={view => navigate({
          route, nav: primaryNav, appId: selectedAppId, chatId: selectedChatId,
          overlay: { kind: 'usage', ...(view === 'insight' ? { view: 'insight' as const } : {}) }
        }, { replace: true })}
        onOpenSession={id => {
          applySessionSelection(id);
          navigate({ route: { kind: 'session', sessionId: id }, nav: 'tasks', appId: selectedAppId, chatId: selectedChatId, overlay: { kind: 'insight' } });
        }}
        onOpenTask={id => {
          applySessionSelection(id);
          navigate({ route: { kind: 'session', sessionId: id }, nav: 'tasks', appId: selectedAppId, chatId: selectedChatId });
        }}
        onCompare={(leftSessionId, rightSessionId) => {
          applySessionSelection(leftSessionId);
          navigate({ route: { kind: 'session', sessionId: leftSessionId }, nav: 'tasks', appId: selectedAppId, chatId: selectedChatId, overlay: { kind: 'insight', compare: rightSessionId } });
        }}
      /></LazyBoundary></Dialog.Body>
    </Dialog>}
    {trace && <SessionTraceView {...trace} onClose={closeOverlay}/>}
    {overlay?.kind === 'insight' && route.kind === 'session' && <Suspense fallback={overlayFallback('正在打开会话分析…')}>
      <SessionInsightPanel
        sessionId={route.sessionId}
        compareSessionId={overlay.compare ?? null}
        onCompareSessionChange={compare => navigate({
          route, nav: primaryNav, appId: selectedAppId, chatId: selectedChatId,
          overlay: { kind: 'insight', ...(compare ? { compare } : {}) }
        }, { replace: true })}
        onClose={closeOverlay}
      />
    </Suspense>}
    {workspaceGroupsOpen && <Suspense fallback={overlayFallback('正在打开整理分组…')}><WorkspaceGroupsModal open onClose={closeWorkspaceGroups} snapshot={workspaceGroups.data} loading={workspaceGroups.isLoading} error={workspaceGroups.error ?? undefined} sessions={visibleSessions} summaries={runSummaries} onRetry={() => void workspaceGroups.refetch()}/></Suspense>}
  </>;
}
