import type { ControlCenterSection } from './components/ControlCenterModal';

/**
 * URL ↔ 界面状态的单一映射。
 *
 * ## 为什么浮层要进 URL
 *
 * 重构前 9 个浮层全无 URL 表示：设置页分享不出去、浏览器后退键关不掉弹层（会直接
 * 跳走或退出站点）、刷新即丢失。「设置与接入」和「飞书 Bot 绑定向导」是最需要
 * 被分享的两个界面——同事问「在哪配飞书」时应该能甩一条链接过去，而不是口述
 * 四步点击路径。
 *
 * ## 什么不进 URL（刻意的）
 *
 * - **归档确认框**：深链打开等于让一条链接直接对别人的任务弹出不可逆操作的确认。
 *   危险操作的确认必须由本次会话里的明确动作触发。
 * - **命令面板 / 快捷键帮助**：瞬态，按一下就开、按 Escape 就关，进 URL 只会污染
 *   历史记录。
 * - **创建任务表单**：URL 恢复不了填了一半的表单，深链过去只是个空表单；而且
 *   「没有 Agent 时改道设置页」的逻辑与 URL 驱动叠加会产生打开即跳转的怪行为。
 *
 * ## 历史记录语义
 *
 * 打开浮层 pushState 一条带 `overlay: true` 标记的 entry，于是后退键关闭浮层。
 * 关闭时若当前 entry 是这样 push 出来的，走 `history.back()` 而不是再 push 一条
 * ——否则后退会把刚关掉的浮层重新打开。直接深链进来的（history.state 无标记）
 * 则用 replaceState 抹掉 query，因为此时 back() 会离开站点。
 */

export type PrimaryNav = 'tasks' | 'bots' | 'groups';

export type AppRoute = { kind: 'overview' } | { kind: 'session'; sessionId: string } | { kind: 'not-found' };

export type OverlayRoute =
  | { kind: 'settings'; section: ControlCenterSection }
  | { kind: 'lark-setup' }
  | { kind: 'groups' }
  | { kind: 'automation' };

export type AppLocation = {
  route: AppRoute;
  nav?: PrimaryNav;
  appId?: string;
  chatId?: string;
  overlay?: OverlayRoute;
};

/** history.state 上的标记：这条 entry 是浮层 push 出来的，关闭时可以安全 back()。 */
export const OVERLAY_HISTORY_MARK = 'dutydeckOverlay';

const controlCenterSections: readonly ControlCenterSection[] = ['agents', 'lark', 'groups', 'automation'];

const isControlCenterSection = (value: string | null): value is ControlCenterSection =>
  value !== null && (controlCenterSections as readonly string[]).includes(value);

export const routeFromPath = (pathname: string): AppRoute => {
  if (pathname === '/') return { kind: 'overview' };
  const match = pathname.match(/^\/sessions\/([^/]+)$/);
  if (!match?.[1]) return { kind: 'not-found' };
  try { return { kind: 'session', sessionId: decodeURIComponent(match[1]) }; }
  catch { return { kind: 'session', sessionId: match[1] }; }
};

const overlayFromSearch = (search: string): OverlayRoute | undefined => {
  const params = new URLSearchParams(search);
  const panel = params.get('panel');
  if (!panel) return undefined;
  switch (panel) {
    case 'settings': {
      // section 缺失或写错时回落到 agents，而不是把整个 panel 判为无效：
      // 用户手改 URL 打错一个词，应该看到设置页，不是看到什么都没发生。
      const section = params.get('section');
      return { kind: 'settings', section: isControlCenterSection(section) ? section : 'agents' };
    }
    case 'lark-setup': return { kind: 'lark-setup' };
    case 'groups': return { kind: 'groups' };
    case 'automation': return { kind: 'automation' };
    default: return undefined;
  }
};

export const parseAppLocation = (pathname: string, search: string): AppLocation => {
  const route = routeFromPath(pathname);
  // 页面本身不存在时不解析浮层：在 not-found 上叠一个设置弹层，用户关掉后
  // 落到的还是死页面，那比不开更让人困惑。
  if (route.kind === 'not-found') return { route };
  const params = new URLSearchParams(search);
  const navParam = params.get('nav');
  const nav: PrimaryNav | undefined = (navParam === 'bots' || navParam === 'groups' || navParam === 'tasks') ? navParam : undefined;
  const appId = params.get('appId') || undefined;
  const chatId = params.get('chatId') || undefined;
  return {
    route,
    ...(nav ? { nav } : {}),
    ...(appId ? { appId } : {}),
    ...(chatId ? { chatId } : {}),
    overlay: overlayFromSearch(search)
  };
};

const routePath = (route: AppRoute): string =>
  route.kind === 'session' ? `/sessions/${encodeURIComponent(route.sessionId)}` : '/';

export const sessionPath = (id?: string) => id ? `/sessions/${encodeURIComponent(id)}` : '/';

/** 反向序列化。route 为 not-found 时无法还原原始路径，调用方不应对它做导航。 */
export const appLocationPath = ({ route, nav, appId, chatId, overlay }: AppLocation): string => {
  const base = routePath(route);
  const params = new URLSearchParams();
  if (nav && nav !== 'tasks') {
    params.set('nav', nav);
    if (appId) params.set('appId', appId);
    if (chatId) params.set('chatId', chatId);
  } else if (nav === 'tasks' && (appId || chatId)) {
    params.set('nav', 'tasks');
    if (appId) params.set('appId', appId);
    if (chatId) params.set('chatId', chatId);
  }
  if (overlay) {
    params.set('panel', overlay.kind);
    if (overlay.kind === 'settings') params.set('section', overlay.section);
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
};
