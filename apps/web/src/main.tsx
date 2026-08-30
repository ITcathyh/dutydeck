import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthGate } from './components/AuthGate';
import './index.css';
const client = new QueryClient();
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={client}><AuthGate><App/></AuthGate></QueryClientProvider></StrictMode>);
