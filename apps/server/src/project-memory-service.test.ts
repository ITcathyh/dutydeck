import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRepositories } from '@dutydeck/storage';
import type { DriverFactory, RuntimeOptions } from '@dutydeck/runtime';
import { agentConfigSchema } from '@dutydeck/shared';
import { startLocalServer } from './service.js';
import { ProjectMemoryService } from './project-memory.js';

it('wires owner APIs and per-turn project memory through the real service and warm runtime send path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-project-service-'));
  const database = join(root, 'state.db');
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') throw new Error('TCP port missing'); server.close(() => resolve(address.port)); });
  });
  const seed = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' }); seed.close();
  const service = await startLocalServer({ webRoot: root, env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', DUTYDECK_HOST: '127.0.0.1', DUTYDECK_PORT: String(port), DUTYDECK_DEFAULT_CWD: root, DUTYDECK_DATABASE_URL: database, DUTYDECK_DAEMON_DIR: join(root, 'daemon'), DUTYDECK_AUTH: 'false', DUTYDECK_DISABLE_LARK_LISTENER: 'true', DUTYDECK_AGENTS_JSON: '[]' } });
  const repos = createRepositories(database);
  try {
    const runtime = service.runtime as unknown as { factory: DriverFactory; options: RuntimeOptions };
    const prompts: string[] = []; let starts = 0;
    const promptHook = vi.fn(runtime.options.sessionPrompt!); runtime.options.sessionPrompt = promptHook;
    runtime.options.probe = () => ({ protocol: 'acp', available: true, pause: false, resume: true });
    runtime.factory = (_agent, _protocol, emit) => ({ isIdle: () => true, hasBackgroundWork: () => false, start: async () => { starts++; }, stop: async () => {}, isStopped: async () => true, interrupt: async () => {}, send: async prompt => { prompts.push(prompt); emit({ type: 'text', data: { text: '完成' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); } });
    await repos.agents.save(agentConfigSchema.parse({ id: 'fake', name: 'Fake', command: 'fake', protocol: 'acp', cwd: root }));
    const first = await service.runtime.start({ agentId: 'fake' }); const second = await service.runtime.start({ agentId: 'fake' });
    const request = async (endpoint: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method, headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(response.status).toBe(200); return response.json();
    };
    const id = (await request('/api/project-memory', 'POST', { name: '服务项目' })).project.id;
    const fingerprint = (await request(`/api/project-memory/${id}`)).fingerprint;
    await request(`/api/project-memory/${id}/entries`, 'POST', { content: '服务接线确认', expectedFingerprint: fingerprint });
    await request(`/api/sessions/${first.id}/project-memory`, 'PUT', { projectId: id });
    for (const mode of ['legacy', 'optimized']) {
      await repos.config.set('token_efficiency', JSON.stringify({ mode, memoryProfiles: [] }));
      const task = await service.runtime.send(first.id, `第一轮-${mode}`); expect(task.status, JSON.stringify(task)).toBe('completed'); expect(prompts.at(-1)).toContain('服务接线确认');
      expect(promptHook.mock.calls.at(-1)?.[2]?.promptPolicyVersion).toBe(mode === 'optimized' ? 'optimized-v1' : 'legacy-v1');
    }
    await service.runtime.send(second.id, '未绑定'); expect(prompts.at(-1)).not.toContain('服务接线确认');
    await request(`/api/sessions/${second.id}/project-memory`, 'PUT', { projectId: id });
    await service.runtime.send(second.id, '显式共享'); expect(prompts.at(-1)).toContain('服务接线确认');
    const startsBeforeControls = starts;
    const writer = new ProjectMemoryService(repos.config, async id => ({ id }));
    await writer.setEnabled(id, false); await service.runtime.send(first.id, '关闭后的新轮次'); expect(prompts.at(-1)).not.toContain('服务接线确认');
    await writer.setEnabled(id, true); await request(`/api/sessions/${first.id}/project-memory`, 'PUT', { projectId: null });
    await service.runtime.send(first.id, '解绑后的新轮次'); expect(prompts.at(-1)).not.toContain('服务接线确认');
    expect(starts).toBe(startsBeforeControls);
  } finally { repos.close(); await service.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
