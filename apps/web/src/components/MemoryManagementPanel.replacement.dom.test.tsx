import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, type Session } from '../api';
import { MemoryManagementPanel } from './MemoryManagementPanel';
import { ProjectMemoryService } from '../../../server/src/project-memory';
import { LarkMemoryStore, larkMemoryFingerprint, larkMemoryScope } from '../../../server/src/lark/memory';
import type { ConfigRepository } from '@dutydeck/shared';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const session: Session = { id: 'review-session', agentId: 'review-agent', cwd: '/project', state: 'created', runId: 'run', createdAt: '', updatedAt: '' };

function mount(component: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
}

function memoryConfig() {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: string) => { values.set(key, value); },
    compareAndSet: async (key: string, expected: string | undefined, value: string) => {
      if (values.get(key) !== expected) return false;
      values.set(key, value);
      return true;
    }
  } as ConfigRepository;
}

async function saveAgainAfterEditingDuringFirstResponse(spy: unknown, finish: () => void) {
  fireEvent.change(screen.getByRole('textbox', { name: '记忆正文' }), { target: { value: 'submitted memory' } });
  fireEvent.click(screen.getByRole('button', { name: '保存修订' }));
  await waitFor(() => expect(spy).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByRole('textbox', { name: '记忆正文' }), { target: { value: 'later memory' } });
  finish();
  await waitFor(() => expect((screen.getByRole('button', { name: '保存修订' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '保存修订' }));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
}

it.each([{ creating: false, scenario: 'revision' }, { creating: true, scenario: 'creation' }])('continues project memory $scenario through the real replacement service', async ({ creating }) => {
  const service = new ProjectMemoryService(memoryConfig(), async () => session);
  const { project } = await service.create('Review project');
  if (!creating) await service.write(project.id, { content: 'original memory', expectedFingerprint: (await service.view(project.id)).fingerprint });
  await service.bind(session.id, project.id);
  vi.spyOn(api, 'projectMemories').mockImplementation(() => service.list());
  vi.spyOn(api, 'projectMemoryBinding').mockImplementation(id => service.binding(id));
  vi.spyOn(api, 'projectMemory').mockImplementation((id, query) => service.view(id, query));
  let finish!: () => void;
  const first = new Promise<void>(resolve => { finish = resolve; });
  let count = 0;
  const results: Array<{ entry: { id: string } }> = [];
  const failures: unknown[] = [];
  const write = vi.spyOn(api, 'writeProjectMemory').mockImplementation(async (id, body, entryId) => {
    if (++count === 1) await first;
    try {
      const result = await service.write(id, { ...body, entryId });
      results.push(result);
      return result;
    } catch (error) {
      failures.push(error);
      throw error;
    }
  });
  mount(<MemoryManagementPanel session={{ ...session, source: 'web' }}/>);
  fireEvent.click(screen.getByRole('button', { name: '管理记忆' }));
  fireEvent.click(await screen.findByRole('button', { name: creating ? '添加记忆' : '修订' }));
  await saveAgainAfterEditingDuringFirstResponse(write, finish);
  await waitFor(() => expect(results.length + failures.length).toBe(2));

  expect(failures).toEqual([]);
  expect(results).toHaveLength(2);
  expect(write.mock.calls[1]?.[2]).toBe(results[0]!.entry.id);
  const entries = (await service.view(project.id)).entries;
  expect(entries.filter(entry => !entry.deletedAt).map(entry => entry.content)).toEqual(['later memory']);
  expect(entries.find(entry => entry.content === 'submitted memory')).toMatchObject({ supersededBy: results[1]!.entry.id });
});

it('continues Lark memory revision through the real replacement store', async () => {
  const store = new LarkMemoryStore(memoryConfig());
  const scope = larkMemoryScope('review-bot', 'review-chat', 'group');
  await store.add(scope, { content: 'original memory', source: 'user' });
  vi.spyOn(api, 'memoryPool').mockImplementation(async () => {
    const entries = await store.listAll(scope);
    return { scope: 'Review pool', entries, fingerprint: larkMemoryFingerprint(entries), historyNotice: '' };
  });
  let finish!: () => void;
  const first = new Promise<void>(resolve => { finish = resolve; });
  let count = 0;
  const results: Array<{ entry: { id: string } }> = [];
  const failures: unknown[] = [];
  const revise = vi.spyOn(api, 'reviseMemoryPool').mockImplementation(async (_session, id, body) => {
    if (++count === 1) await first;
    try {
      const result = { entry: await store.revise(scope, id, { ...body, actor: 'installation_owner' }) };
      results.push(result);
      return result;
    } catch (error) {
      failures.push(error);
      throw error;
    }
  });
  mount(<MemoryManagementPanel session={{ ...session, source: 'lark' }}/>);
  fireEvent.click(screen.getByRole('button', { name: '管理记忆' }));
  fireEvent.click(await screen.findByRole('button', { name: '修订' }));
  await saveAgainAfterEditingDuringFirstResponse(revise, finish);
  await waitFor(() => expect(results.length + failures.length).toBe(2));

  expect(failures).toEqual([]);
  expect(results).toHaveLength(2);
  expect(revise.mock.calls[1]?.[1]).toBe(results[0]!.entry.id);
  expect((await store.list(scope)).map(entry => entry.content)).toEqual(['later memory']);
  expect((await store.listAll(scope)).find(entry => entry.content === 'submitted memory')).toMatchObject({ supersededBy: results[1]!.entry.id });
});
