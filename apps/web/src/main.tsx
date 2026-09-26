import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthGate } from './components/AuthGate';
import { setShareToken } from './api';
import { sharedSessionFromLocation, routeFromPath } from './app-route';
import { instanceFromPath, setInstance } from './instance';
import './index.css';
const client = new QueryClient();
setInstance(instanceFromPath(window.location.pathname));
// 分享页只凭链接里的分享 token 读一个会话，不经过登录，也不渲染工作台。
const shared = sharedSessionFromLocation(window.location.pathname, window.location.hash);
if (shared) setShareToken(shared.token);
// Fetch the selected route and its timeline together. Mounting an already
// loaded route directly avoids a second Suspense fallback after authentication.
if (shared || routeFromPath(window.location.pathname).kind === 'session') void import('./components/TimelineView');
const root = createRoot(document.getElementById('root')!);
const page = shared
  ? import('./components/SharedSessionPage').then(({ SharedSessionPage }) => <SharedSessionPage sessionId={shared.sessionId}/>)
  : import('./App').then(({ default: App }) => <AuthGate><App/></AuthGate>);
void page.then(content => root.render(<StrictMode><QueryClientProvider client={client}>{content}</QueryClientProvider></StrictMode>));
