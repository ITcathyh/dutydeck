import { useCallback, useEffect, useRef, useState } from 'react';
import { appLocationPath, OVERLAY_HISTORY_MARK, parseAppLocation, type AppLocation, type OverlayRoute, type PrimaryNav, type LarkSetupTarget } from './app-route';
import type { ControlCenterSection, SettingsLeaveGuard } from './components/ControlCenterModal';
import { useExperimental } from './experimental';
import { captureDialogOpener } from './useDialogFocus';
import { useViewPreference } from './view-preferences';
import type { WorkbenchView } from './workspace-model';

type TaskListFilters = { view: WorkbenchView; query: string; project: string };
const LIST_HISTORY_KEY = 'dutydeckTaskFilters';
const HISTORY_POSITION_KEY = 'dutydeckHistoryPosition';
const isTaskListFilters = (value: unknown): value is TaskListFilters => value !== null && typeof value === 'object' && 'view' in value && ['all', 'attention', 'active', 'completed', 'archived'].includes(String(value.view)) && 'query' in value && typeof value.query === 'string' && 'project' in value && typeof value.project === 'string';

const currentLocation = (): AppLocation => typeof window === 'undefined'
  ? { route: { kind: 'overview' } }
  : parseAppLocation(window.location.pathname, window.location.search);

export function useAppLocation(applySessionSelection: (id?: string) => void) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // 路由与「可深链的浮层」是同一个东西的两半，合成一个 state：分开存会让 URL 与界面
  // 各走各的，回退键、刷新、分享链接三者立刻打架（见 app-route.ts 的说明）。
  const [location, setLocation] = useState<AppLocation>(currentLocation);
  const settingsLeaveGuard = useRef<SettingsLeaveGuard | undefined>(undefined);
  const registerSettingsLeaveGuard = useCallback((guard: SettingsLeaveGuard | undefined) => { settingsLeaveGuard.current = guard; }, []);
  const historyEntry = useRef({ path: `${window.location.pathname}${window.location.search}`, state: window.history.state, position: Number(window.history.state?.[HISTORY_POSITION_KEY] ?? 0) });
  const restoringSettingsHistory = useRef<{ path: string; restored(): void } | undefined>(undefined);
  const route = location.route;
  const [experimental] = useExperimental();
  // 群与权限只有草稿态：实验功能关闭时，?panel=groups 深链不打开浮层。
  const overlay = location.overlay?.kind === 'groups' && !experimental ? undefined : location.overlay;
  // 主区一级视图与选中对象。三者都在 URL 里，刷新和分享都能回到同一个对象
  // （app-route.ts 的 nav/appId/chatId）。
  const primaryNav: PrimaryNav = location.nav ?? (route.kind === 'session' ? 'tasks' : 'home');
  const selectedAppId = location.appId;
  const selectedChatId = location.chatId;
  const [taskFilters, setTaskFiltersPreference] = useViewPreference<TaskListFilters>('task-filters', { view: 'all', query: '', project: '' }, isTaskListFilters);
  const taskFiltersRef = useRef(taskFilters);
  taskFiltersRef.current = taskFilters;
  const workbenchView = taskFilters.view;
  const updateTaskFilters = (patch: Partial<TaskListFilters>) => {
    const next = { ...taskFiltersRef.current, ...patch };
    taskFiltersRef.current = next;
    setTaskFiltersPreference(next);
    if (route.kind === 'overview' && primaryNav === 'tasks') window.history.replaceState({ ...window.history.state, [LIST_HISTORY_KEY]: next }, '', window.location.href);
  };
  const setWorkbenchView = (view: WorkbenchView) => updateTaskFilters({ view });

  /**
   * 写 URL 并同步界面状态。
   *
   * 打开浮层时在 history.state 上打 `OVERLAY_HISTORY_MARK` 标记，这样关闭时能分辨
   * 两种来路：本次会话里点开的（back() 回到浮层之前，后退键行为自然），还是别人
   * 甩过来的深链（此时 back() 会离开站点，改用 replaceState 抹掉 query）。
   */
  const navigate = useCallback((next: AppLocation, options?: { replace?: boolean }) => {
    const commit = () => {
      setLocation(next);
      const nextPath = appLocationPath(next);
      if (`${window.location.pathname}${window.location.search}` === nextPath) return;
      const position = historyEntry.current.position + (options?.replace ? 0 : 1);
      const state = { [HISTORY_POSITION_KEY]: position, [LIST_HISTORY_KEY]: taskFiltersRef.current, sessionId: next.route.kind === 'session' ? next.route.sessionId : undefined, ...(next.overlay ? { [OVERLAY_HISTORY_MARK]: true } : {}) };
      if (options?.replace) window.history.replaceState(state, '', nextPath);
      else window.history.pushState(state, '', nextPath);
      historyEntry.current = { path: nextPath, state, position };
    };
    if (settingsLeaveGuard.current) settingsLeaveGuard.current(commit);
    else commit();
  }, []);

  const openOverlay = useCallback((next: OverlayRoute) => {
    captureDialogOpener();
    setSidebarOpen(false);
    navigate({ route, nav: primaryNav, appId: selectedAppId, chatId: selectedChatId, overlay: next });
  }, [navigate, route, primaryNav, selectedAppId, selectedChatId]);

  /**
   * 关闭可深链浮层。
   *
   * 走 back() 而不是再 push 一条：否则用户按后退会把刚关掉的浮层重新打开，
   * 而且每开关一次就往历史里塞两条记录。
   */
  const closeOverlay = useCallback(() => {
    const pushedByUs = Boolean((window.history.state as Record<string, unknown> | null)?.[OVERLAY_HISTORY_MARK]);
    if (pushedByUs) { window.history.back(); return; }
    navigate({ route, nav: primaryNav, appId: selectedAppId, chatId: selectedChatId }, { replace: true });
  }, [navigate, route, primaryNav, selectedAppId, selectedChatId]);

  /**
   * 选中任务。
   *
   * 一律切回任务视图（点任务却停在 Bot 管理页上，是在无视用户刚做的选择），
   * 但 appId / chatId 原样留在 URL 里：用户从任务详情跳去改配置、再切回来时
   * 仍然落在原来那个 Bot 或群上，不用重新找一遍。
   */
  const selectSession = useCallback((id?: string) => {
    applySessionSelection(id);
    navigate({ route: id ? { kind: 'session', sessionId: id } : { kind: 'overview' }, nav: id ? 'tasks' : 'home', appId: selectedAppId, chatId: selectedChatId });
  }, [applySessionSelection, navigate, selectedAppId, selectedChatId]);

  /**
   * 切换主区一级视图。
   *
   * `route` 原样保留：用户在任务详情里切去「机器人」，主区换成 Bot 管理，但
   * 那条任务仍在 URL 里；切回「任务」直接回到同一条任务，不用重新找。这正是
   * 契约要求的「跳转配置再返回不丢任务」。
   */
  const setPrimaryNav = useCallback((next: PrimaryNav) => {
    const returningToTask = next === 'tasks' && (primaryNav === 'bots' || primaryNav === 'groups') && route.kind === 'session';
    const destination = ['home', 'tasks', 'automation'].includes(next) && !returningToTask ? { kind: 'overview' as const } : route;
    if (destination.kind === 'overview') applySessionSelection(undefined);
    setSidebarOpen(false);
    navigate({ route: destination, nav: next, appId: selectedAppId, chatId: selectedChatId });
  }, [navigate, route, applySessionSelection, primaryNav, selectedAppId, selectedChatId]);

  /** 选中某个 Bot，进入机器人视图。chatId 保留，便于从 Bot 再跳回原来的群。 */
  const selectBot = useCallback((appId: string) => {
    navigate({ route, nav: 'bots', appId: appId || undefined, chatId: selectedChatId });
  }, [navigate, route, selectedChatId]);

  /** 选中某个群，进入群聊视图；带上 appId 时直接定位到该群里的这个 Bot。 */
  const selectGroup = useCallback((chatId: string, appId?: string) => {
    navigate({ route, nav: 'groups', chatId: chatId || undefined, appId: appId ?? selectedAppId });
  }, [navigate, route, selectedAppId]);

  const openSettings = (section: ControlCenterSection = 'agents') => openOverlay({ kind: 'settings', section });
  const openLarkSetup = (target?: LarkSetupTarget) => openOverlay({ kind: 'lark-setup', target });

  useEffect(() => {
    const syncSelectionFromLocation = () => {
      const path = `${window.location.pathname}${window.location.search}`;
      const restoration = restoringSettingsHistory.current;
      if (restoration?.path === path) {
        restoringSettingsHistory.current = undefined;
        restoration.restored();
        return;
      }
      const next = currentLocation();
      const state = window.history.state;
      const position: unknown = state?.[HISTORY_POSITION_KEY];
      const commit = () => {
        const savedFilters: unknown = state?.[LIST_HISTORY_KEY];
        if (isTaskListFilters(savedFilters)) {
          taskFiltersRef.current = savedFilters;
          setTaskFiltersPreference(savedFilters);
        }
        const nextPosition = typeof position === 'number' ? position : historyEntry.current.position;
        const nextState = { ...state, [HISTORY_POSITION_KEY]: nextPosition, [LIST_HISTORY_KEY]: taskFiltersRef.current };
        window.history.replaceState(nextState, '', path);
        historyEntry.current = { path, state: nextState, position: nextPosition };
        setLocation(next);
        applySessionSelection(next.route.kind === 'session' ? next.route.sessionId : undefined);
      };
      if (!settingsLeaveGuard.current || path === historyEntry.current.path) { commit(); return; }
      // popstate 已经移动了浏览器历史。先回到草稿 entry，确认后才重新走向目标。
      const source = historyEntry.current;
      const delta = typeof position === 'number' ? position - source.position : 0;
      let restored = false;
      let approved = false;
      const replay = () => { settingsLeaveGuard.current = undefined; window.history.go(delta || -1); };
      const allowed = settingsLeaveGuard.current(() => { approved = true; if (restored) replay(); });
      if (allowed) { commit(); return; }
      if (delta) {
        restoringSettingsHistory.current = { path: source.path, restored: () => { restored = true; if (approved) replay(); } };
        window.history.go(-delta);
      } else {
        // 旧 entry 没有位置标记：保留目标，再补回当前设置 entry，避免守卫反复触发。
        window.history.replaceState({ ...state, [HISTORY_POSITION_KEY]: source.position - 1 }, '', path);
        window.history.pushState(source.state, '', source.path);
        restored = true;
        if (approved) replay();
      }
    };
    syncSelectionFromLocation();
    window.addEventListener('popstate', syncSelectionFromLocation);
    return () => window.removeEventListener('popstate', syncSelectionFromLocation);
  }, [applySessionSelection]);

  return {
    location, route, overlay, primaryNav, selectedAppId, selectedChatId, experimental,
    sidebarOpen, setSidebarOpen, taskFilters, workbenchView, updateTaskFilters, setWorkbenchView,
    navigate, openOverlay, closeOverlay, selectSession, setPrimaryNav, selectBot, selectGroup,
    openSettings, openLarkSetup, registerSettingsLeaveGuard
  };
}
