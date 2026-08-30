// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from './api';
import App from './App';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('App mobile navigation accessibility', () => {
  it('makes the background inert, moves focus into navigation, and restores focus on Escape', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.spyOn(api, 'agents').mockResolvedValue([]);
    vi.spyOn(api, 'sessions').mockResolvedValue([]);
    vi.spyOn(api, 'runSummaries').mockResolvedValue([]);
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: false, bots: [], listeningDisabled: false });
    vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
    const trigger = await screen.findByRole('button', { name: '打开工作台导航' });
    trigger.focus();
    await userEvent.click(trigger);
    const main = container.querySelector('main')!;
    expect(main.hasAttribute('inert')).toBe(true);
    expect(main.getAttribute('aria-hidden')).toBe('true');
    const navigation = screen.getByRole('complementary', { name: 'Dockmux 工作台导航', hidden: true });
    await waitFor(() => expect(navigation.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('{Escape}');
    expect(main.hasAttribute('inert')).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
