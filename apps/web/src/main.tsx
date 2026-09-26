import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthGate } from './components/AuthGate';
import { SharedSessionPage } from './components/SharedSessionPage';
import { setShareToken } from './api';
import { sharedSessionFromLocation } from './app-route';
import { instanceFromPath, setInstance } from './instance';
import './index.css';
const client = new QueryClient();
setInstance(instanceFromPath(window.location.pathname));
// 分享页只凭链接里的分享 token 读一个会话，不经过登录，也不渲染工作台。
const shared = sharedSessionFromLocation(window.location.pathname, window.location.hash);
if (shared) setShareToken(shared.token);
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={client}>{shared ? <SharedSessionPage sessionId={shared.sessionId}/> : <AuthGate><App/></AuthGate>}</QueryClientProvider></StrictMode>);
