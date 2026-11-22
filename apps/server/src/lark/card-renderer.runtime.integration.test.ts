import { defaultDriverProviders } from '../driver-providers.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type NormalizedDriverEvent } from '@dutydeck/runtime';
import { normalizeAcpxEvent } from '@dutydeck/acp-client';
import type { AgentConfig } from '@dutydeck/shared';
import { eventsForRuntimeTask, renderLarkResultElements } from './card-renderer.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function persistAndRender(event: NormalizedDriverEvent) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-renderer-runtime-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    providers: defaultDriverProviders(),
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
      isStopped: async () => true,
      send: async () => {
        emit(event);
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    })
  });
  cleanups.push(async () => { await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id, cwd });
  const task = await runtime.send(session.id, 'render persisted content');
  const events = eventsForRuntimeTask(await runtime.getEvents(session.id), task.id);
  const saved = events.find(item => item.type === 'text' && (item.data as any).role !== 'user');
  return { task, saved, rendered: renderLarkResultElements(events, { state: task.status, agentName: 'Mock' }) };
}

it('真实 runtime 持久化非数组 parts 后仍渲染合法正文', async () => {
  const { task, saved, rendered } = await persistAndRender({ type: 'text', data: { text: '合法最终正文', parts: { unexpected: true } } });
  expect(task.status).toBe('completed');
  expect(saved?.data).toMatchObject({ text: '合法最终正文', parts: { unexpected: true } });
  expect(rendered.find(element => element.element_id === 'final_output')?.content).toBe('合法最终正文');
  expect(rendered.some(element => element.element_id === 'result_missing')).toBe(false);
});

it('真实 ACP 归一化与 SQLite 保留超预算图片事实，卡片不再误报无输出', async () => {
  const normalized = normalizeAcpxEvent({ params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'a'.repeat(128 * 1024 + 1) } } } });
  expect(normalized).toBeDefined();
  const { task, saved, rendered } = await persistAndRender(normalized!);
  expect(task.status).toBe('failed');
  expect(saved?.data).toMatchObject({ parts: [{ type: 'unsupported', originalType: 'image', reason: 'content_budget' }] });
  expect(rendered.find(element => element.element_id === 'final_output')?.content)
    .toBe('Agent 返回了 1 个图片结果，但图片超过保存上限，图片内容未保留。');
  expect(JSON.stringify(rendered)).not.toContain('Agent 未返回最终输出');
  expect(JSON.stringify(rendered)).not.toContain('Web');
});
