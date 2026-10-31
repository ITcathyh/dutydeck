// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { CommandPalette } from './components/CommandPalette';
import { appLocationPath, parseAppLocation } from './app-route';
import { botSettingFields, botDetailFields, settingsSearchActions } from './settings-search';
afterEach(cleanup);
it('indexes form metadata without config values, disambiguates identical bot names and navigates by keyboard', async () => {
  const navigate = vi.fn();
  const actions = settingsSearchActions([{ name: '机器人甲', appId: 'cli_first' }, { name: '机器人甲', appId: 'cli_second' }], navigate);
  expect(actions).toHaveLength(2 * (Object.keys(botSettingFields).length + Object.keys(botDetailFields).length + 1) + 1);
  render(<CommandPalette open onClose={() => {}} sessions={[]} summaries={{}} agents={[]} actions={actions} onSelectSession={() => {}}/>);
  const user = userEvent.setup();
  const input = screen.getByRole('combobox');
  await user.type(input, '机器人甲 cli_second 回复方式');
  const options = screen.getAllByRole('option');
  expect(options.length).toBeGreaterThan(0);
  expect(options.every(item => item.textContent?.includes('cli_second'))).toBe(true);
  await user.keyboard('{Enter}');
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'bot-settings', appId: 'cli_second', field: 'p2pMode' }));
});
it('serializes exact field routes for browser back, forward, and reload', () => {
  for (const overlay of [{ kind: 'lark-setup' as const, target: { appId: 'cli_second' }, field: 'notifyQuietHours' }, { kind: 'settings' as const, section: 'agents' as const, field: 'terminalBackend' }]) {
    const path = appLocationPath({ route: { kind: 'overview' }, overlay });
    const url = new URL(path, 'https://test.local');
    expect(parseAppLocation(url.pathname, url.search).overlay).toEqual(overlay);
  }
});

it.each(['claude.gateway', 'custom/代理 ?#%'])('roundtrips a schema-valid Agent ID %s through search and its DOM anchor', async id => {
  const { agentConfigSchema } = await import('@dutydeck/shared');
  const { modelSettingAnchor } = await import('./settings-search');
  expect(agentConfigSchema.safeParse({ id, name: 'Custom', command: 'claude', adapterId: 'claude', protocol: 'pty-cli' }).success).toBe(true);
  const navigate = vi.fn();
  const actions = settingsSearchActions([], navigate, [{ id, name: 'Custom', protocol: 'pty-cli', permissionMode: 'ask', modelServiceSettings: true }]);
  actions.find(action => action.id === `settings-model-${id}-baseUrl`)!.run();
  const destination = navigate.mock.calls[0]![0];
  expect(destination.field).toBe(modelSettingAnchor(id, 'baseUrl'));
  const url = new URL(appLocationPath({ route: { kind: 'overview' }, overlay: destination }), 'https://test.local');
  expect(parseAppLocation(url.pathname, url.search).overlay).toEqual(destination);
  url.searchParams.set('panel', 'lark-setup');
  expect(parseAppLocation(url.pathname, url.search).overlay).not.toHaveProperty('field');
  expect(parseAppLocation('/', `?nav=bots&botField=${encodeURIComponent(destination.field)}`)).not.toHaveProperty('botField');
});
