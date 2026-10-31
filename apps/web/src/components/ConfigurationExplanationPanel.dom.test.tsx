import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConfigurationExplanation } from '@dutydeck/shared';
import { PluginBindingsPanel } from './PluginBindingsPanel';
import { pluginBindingsApi } from '../api';
import { configurationApi } from '../api';
import { ConfigurationExplanationPanel } from './ConfigurationExplanationPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const result: ConfigurationExplanation = { sessionId: 's', observedAt: '', tasks: [{ id: 'task-one', attempts: [{ id: 'attempt-one', number: 1, state: 'settled' }, { id: 'attempt-two', number: 2, state: 'preparing' }] }], sections: [
  { phase: 'saved', title: '已保存 · 后续启动', note: '后续启动才使用', fields: [{ key: 'model', label: '模型', value: 'B', source: 'group_override', status: 'recorded', reason: '群设置覆盖机器人默认 A', revision: 2 }] },
  { phase: 'session', title: '当前会话', note: '当前会话记录', fields: [{ key: 'model', label: '模型', value: 'A', source: '会话记录', status: 'recorded' }] },
  { phase: 'native', title: '外部 CLI 配置', note: '不扫描秘密文件', fields: [{ key: 'native', label: '私有配置', source: '原生观测', status: 'unverified' }] }
] };
function mount() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ConfigurationExplanationPanel sessionId="s"/></QueryClientProvider>); }

it('opens a discoverable source view on demand, explains overrides, selects a task/attempt and keeps missing history unknown', async () => {
  const explain = vi.spyOn(configurationApi, 'explain').mockImplementation(async (_session, taskId, attemptId) => ({ ...result, taskId, attemptId, sections: [...result.sections, ...(taskId ? [{ phase: 'attempt' as const, title: '指定任务 / attempt', note: attemptId || '当前 attempt', fields: [{ key: 'cwd', label: '历史工作目录', source: '历史快照', status: 'unknown' as const }] }] : [])] }));
  mount(); expect(explain).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '配置来源' }));
  expect(await screen.findByText('已保存 · 后续启动')).toBeTruthy();
  expect(screen.getByText('未核验（unverified）')).toBeTruthy();
  const source = screen.getByText(/来源：群显式覆盖/); fireEvent.click(source);
  expect(source.parentElement?.hasAttribute('open')).toBe(true);
  expect(screen.getByText('群设置覆盖机器人默认 A')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('历史任务'), { target: { value: 'task-one' } });
  expect(await screen.findByText('未记录（unknown）')).toBeTruthy();
  await waitFor(() => expect(screen.getByRole('option', { name: '第 1 次 · settled' })).toBeTruthy());
  fireEvent.change(screen.getByLabelText('执行尝试'), { target: { value: 'attempt-one' } });
  await waitFor(() => expect(explain).toHaveBeenLastCalledWith('s', 'task-one', 'attempt-one'));
  fireEvent.click(screen.getByRole('button', { name: '刷新配置来源' }));
  await waitFor(() => expect(explain.mock.calls.length).toBeGreaterThanOrEqual(4));
  fireEvent.click(screen.getByRole('button', { name: '配置来源' }));
  expect(screen.queryByLabelText('历史任务')).toBeNull();
});

it('reports read failures without presenting fabricated source values', async () => {
  vi.spyOn(configurationApi, 'explain').mockRejectedValue(new Error('Forbidden'));
  mount(); fireEvent.click(screen.getByRole('button', { name: '配置来源' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Forbidden');
  expect(screen.queryByText('B')).toBeNull();
});

it('presents the plugin settings explanation through readable source fields without config bodies', async () => {
  vi.spyOn(pluginBindingsApi, 'list').mockResolvedValue({ bindings: [], diagnostics: [], packages: [{ name: 'sample', scope: 'global', apiVersion: 1, requiredSkills: [], legacyGlobal: [], configSchema: {} }] });
  vi.spyOn(pluginBindingsApi, 'explain').mockResolvedValue({ binding: { id: 'binding-one', revision: 3, config: { endpoint: 'private-config-body' }, secretKeys: ['token'] }, skills: [{ ref: 'sample/review' }] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PluginBindingsPanel/></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText('插件'), { target: { value: 'sample' } });
  fireEvent.change(screen.getByLabelText('Bot App ID'), { target: { value: 'bot' } });
  fireEvent.click(screen.getByRole('button', { name: '解释已保存配置' }));
  expect(await screen.findByText('已保存插件配置来源')).toBeTruthy();
  expect(screen.getByText('binding-one')).toBeTruthy(); expect(screen.getByText('sample/review')).toBeTruthy();
  expect(screen.queryByText('private-config-body')).toBeNull();
});
