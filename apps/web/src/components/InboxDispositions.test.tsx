import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InboxDispositions } from './InboxDispositions';
import { api } from '../api';
it('shows ignored message details and switches the time range', async () => {
 const read = vi.spyOn(api,'larkInbox').mockResolvedValue([{messageId:'om_1',sender:'用户甲',snippet:'帮忙看看',reason:'not_addressed',detail:'没有叫本机器人',receivedAt:'2026-11-01'}]);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><InboxDispositions appId="app"/></QueryClientProvider>);
 expect(await screen.findByText(/没有叫本机器人/)).toBeTruthy();
 expect(screen.getByText(/用户甲/)).toBeTruthy();
 expect(read).toHaveBeenCalledWith('app','24h');
 fireEvent.change(screen.getByLabelText('消息时间范围'),{target:{value:'30d'}});
 await waitFor(() => expect(read).toHaveBeenCalledWith('app','30d'));
 read.mockRestore();
});
