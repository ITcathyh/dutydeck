import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthGate } from './components/AuthGate';
import { setShareToken } from './api';
import { sharedSessionFromLocation, routeFromPath, turnDiffFromLocation } from './app-route';
import { instanceFromPath, setInstance } from './instance';
import './index.css';
const client = new QueryClient();
setInstance(instanceFromPath(window.location.pathname));
// 分享页只凭链接里的分享 token 读一个会话，不经过登录，也不渲染工作台。
const shared = sharedSessionFromLocation(window.location.pathname, window.location.hash);
if (shared) setShareToken(shared.token);
// 「查看改动」页：带 token 时同分享页，只凭链接读这一轮的改动；不带时是登录用户从工作台点进来的。
const diff = shared ? undefined : turnDiffFromLocation(window.location.pathname, window.location.hash);
if (diff?.token !== undefined) setShareToken(diff.token);
// Fetch the selected route and its timeline together. Mounting an already
// loaded route directly avoids a second Suspense fallback after authentication.
if (shared || routeFromPath(window.location.pathname).kind === 'session') void import('./components/TimelineView');
const root = createRoot(document.getElementById('root')!);
const page = shared
  ? import('./components/SharedSessionPage').then(({ SharedSessionPage }) => <SharedSessionPage sessionId={shared.sessionId}/>)
  : diff
    ? import('./components/TurnDiffPage').then(({ TurnDiffPage }) => diff.token !== undefined
      ? <TurnDiffPage sessionId={diff.sessionId} taskId={diff.taskId} shared/>
      : <AuthGate><TurnDiffPage sessionId={diff.sessionId} taskId={diff.taskId} shared={false}/></AuthGate>)
    : import('./App').then(({ default: App }) => <AuthGate><App/></AuthGate>);
void page.then(content => root.render(<StrictMode><QueryClientProvider client={client}>{content}</QueryClientProvider></StrictMode>));
