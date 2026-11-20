import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type Agent, type Session, type Task } from '../api';
import { setInstance } from '../instance';
import { newSessionDrafts } from '../new-session-drafts';
import { useNewSession } from '../useNewSession';
import { HomeTaskComposer } from './HomeTaskComposer';
import { NewSessionDialog } from './NewSessionModal';

const agent: Agent = { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'ask' };
const session: Session = { id: 'new', agentId: 'codex', state: 'idle', cwd: '/repo', runId: 'r1', createdAt: '', updatedAt: '' };
const task: Task = { id: 't1', sessionId: 'new', prompt: '检查变更', status: 'queued', createdAt: '', updatedAt: '' };
const goal = () => screen.getByPlaceholderText('有什么要做的？') as HTMLTextAreaElement;

function mount(configured?: Agent, onCreated = vi.fn()) {
  function Surfaces({ agents }: { agents: Agent[] }) {
    const [open, setOpen] = useState(false);
    const creation = useNewSession({ agents, onCreated });
    return <>
      <HomeTaskComposer creation={creation} onOpenSettings={() => setOpen(true)}/>
      {open && <NewSessionDialog open creation={creation} agents={agents} onClose={() => setOpen(false)}/>}
    </>;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = (agents: Agent[]) => <QueryClientProvider client={client}><Surfaces agents={agents}/></QueryClientProvider>;
  const rendered = render(view(configured ? [configured] : []));
  return { ...rendered, updateAgents: (agents: Agent[]) => rendered.rerender(view(agents)), onCreated };
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN');
  vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
});

afterEach(() => { cleanup(); newSessionDrafts.clear(); setInstance(undefined); vi.restoreAllMocks(); });

it('blocks IME confirmation and requires explicit full trust even if the Agent loads after the home page', async () => {
  const create = vi.spyOn(api, 'create').mockResolvedValue(session);
  const send = vi.spyOn(api, 'send').mockResolvedValue({ accepted: true, task });
  const { updateAgents, onCreated } = mount();
  expect(screen.queryByPlaceholderText('有什么要做的？')).toBeNull();
  updateAgents([{ ...agent, permissionMode: 'full-trust' }]);

  fireEvent.change(goal(), { target: { value: task.prompt } });
  fireEvent.keyDown(goal(), { key: 'Enter', isComposing: true });
  fireEvent.keyDown(goal(), { key: 'Enter', keyCode: 229 });
  fireEvent.keyDown(goal(), { key: 'Enter', shiftKey: true });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(create).not.toHaveBeenCalled();
  fireEvent.keyDown(goal(), { key: 'Enter' });
  const dialog = screen.getByRole('dialog', { name: '创建新任务' });
  expect((within(dialog).getByLabelText('任务目标') as HTMLTextAreaElement).value).toBe(task.prompt);
  const submit = within(dialog).getByRole('button', { name: '创建并执行' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(create).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  const confirmation = within(dialog).getByRole('checkbox', { name: /确认允许 Agent 直接操作/ });
  await waitFor(() => expect(document.activeElement).toBe(confirmation));
  fireEvent.click(confirmation);
  fireEvent.click(submit);
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(session, task));
  expect(create).toHaveBeenCalledExactlyOnceWith({ agentId: agent.id, permissionMode: 'full-trust', workspaceMode: 'worktree' });
});

it('reuses a previous selection and updates it and the goal when the dialog closes', () => {
  newSessionDrafts.set('@local:task', { agentId: agent.id, cwd: '/project', workspaceMode: 'shared', permissionMode: 'deny-all', model: '', codexProfile: '', reasoningEffort: '', goal: '上次目标' });
  mount(agent);
  const summary = screen.getByRole('button', { name: '修改任务设置' });
  expect(summary.textContent).toContain('Codex');
  expect(summary.textContent).toContain('/project');
  expect(summary.textContent).toContain('直接使用所选目录');
  expect(summary.textContent).toContain('全部拒绝');
  expect(goal().value).toBe('上次目标');
  fireEvent.click(summary);
  const dialog = within(screen.getByRole('dialog', { name: '创建新任务' }));
  fireEvent.change(dialog.getByLabelText('工作目录'), { target: { value: '/another' } });
  fireEvent.change(dialog.getByLabelText('任务目标'), { target: { value: '弹窗内修改' } });
  fireEvent.click(dialog.getByRole('button', { name: '取消' }));
  expect(summary.textContent).toContain('/another');
  expect(goal().value).toBe('弹窗内修改');
});

it('sends directly from home once and clears the goal on the first accepted receipt', async () => {
  const create = vi.spyOn(api, 'create').mockResolvedValue(session);
  const send = vi.spyOn(api, 'send').mockResolvedValue({ accepted: true, task });
  const { onCreated } = mount(agent);
  fireEvent.change(goal(), { target: { value: task.prompt } });
  fireEvent.keyDown(goal(), { key: 'Enter' });
  fireEvent.keyDown(goal(), { key: 'Enter', repeat: true });
  await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(session, task));
  expect(create).toHaveBeenCalledExactlyOnceWith({ agentId: agent.id, permissionMode: 'ask', workspaceMode: 'worktree' });
  expect(send).toHaveBeenCalledExactlyOnceWith(session.id, task.prompt, 'queue', undefined, expect.stringMatching(/^[0-9a-f-]{36}$/));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(goal().value).toBe('');
});

function editTemplate(title: string, body: string) {
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.change(dialog.getByLabelText('模板标题'), { target: { value: title } });
  fireEvent.change(dialog.getByLabelText('模板正文'), { target: { value: body } });
  fireEvent.click(dialog.getByRole('button', { name: '保存模板' }));
}

it('fills and appends editable goal text, persists template CRUD, and isolates templates by instance', () => {
  const view = mount(agent);
  const templates = screen.getByRole('region', { name: '提示词模板' });
  expect(within(templates).getAllByRole('button')).toHaveLength(6);
  fireEvent.click(within(templates).getByRole('button', { name: '修复 Bug' }));
  const builtIn = goal().value;
  expect(builtIn).toContain('复现');
  fireEvent.click(within(templates).getByRole('button', { name: '新建模板' }));
  editTemplate('个人检查', '关注错误路径');
  fireEvent.click(within(templates).getByRole('button', { name: '个人检查' }));
  expect(goal().value).toBe(`${builtIn}\n\n关注错误路径`);
  fireEvent.change(goal(), { target: { value: '保留原文  \n' } });
  fireEvent.click(within(templates).getByRole('button', { name: '个人检查' }));
  expect(goal().value).toBe('保留原文  \n\n关注错误路径');
  fireEvent.change(goal(), { target: { value: '手工补充' } });
  expect(goal().value).toBe('手工补充');
  fireEvent.click(within(templates).getByRole('button', { name: '编辑模板：个人检查' }));
  editTemplate('检查边界', '关注空值');
  view.unmount();
  setInstance('local');
  const peer = mount(agent);
  expect(screen.queryByRole('button', { name: '检查边界' })).toBeNull();
  peer.unmount();
  setInstance(undefined);
  const root = mount(agent);
  expect(screen.queryByRole('button', { name: '个人检查' })).toBeNull();
  expect(screen.getByRole('button', { name: '检查边界' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '删除模板：检查边界' }));
  root.unmount();
  mount(agent);
  expect(screen.queryByRole('button', { name: '检查边界' })).toBeNull();
});

it('shows limits for title, body and custom template count', () => {
  const view = mount(agent);
  fireEvent.click(screen.getByRole('button', { name: '新建模板' }));
  editTemplate('字'.repeat(41), '正文');
  expect(screen.getByRole('alert').textContent).toContain('40');
  editTemplate('标题', '字'.repeat(20001));
  expect(screen.getByRole('alert').textContent).toContain('20000');
  editTemplate('字'.repeat(40), '字'.repeat(20000));
  expect(screen.queryByRole('dialog')).toBeNull();
  const key = localStorage.key(0)!;
  const entry = JSON.parse(localStorage.getItem(key)!)[0];
  localStorage.setItem(key, JSON.stringify(Array.from({ length: 50 }, (_, index) => ({ ...entry, id: `template-${index}`, title: `模板 ${index}` }))));
  view.unmount();
  mount(agent);
  fireEvent.click(screen.getByRole('button', { name: '新建模板' }));
  expect(screen.getByRole('alert').textContent).toContain('50');
  expect(screen.getByRole('button', { name: '模板 49' })).toBeTruthy();
});

it.each(['getItem', 'setItem'] as const)('keeps edits through navigation when browser storage %s throws', method => {
  setInstance(`storage-${method.toLowerCase()}`);
  vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error('Storage unavailable'); });
  if (method === 'getItem') vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  const view = mount(agent);
  if (method === 'getItem') expect(screen.getByText(/刷新后会丢失/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '新建模板' }));
  editTemplate('只在本页', '离线使用');
  expect(screen.getByText(/刷新后会丢失/)).toBeTruthy();
  view.unmount();
  mount(agent);
  fireEvent.click(screen.getByRole('button', { name: '只在本页' }));
  expect(goal().value).toBe('离线使用');
  expect(screen.getByText(/刷新后会丢失/)).toBeTruthy();
});

it('uses English template labels and bodies for an English browser', () => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  mount(agent);
  const templates = screen.getByRole('region', { name: 'Prompt templates' });
  fireEvent.click(within(templates).getByRole('button', { name: 'Fix a bug' }));
  expect(goal().value).toContain('Reproduce');
});
