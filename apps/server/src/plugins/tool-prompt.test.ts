import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { RuntimeOptions } from '@dutydeck/runtime';
import type { Session } from '@dutydeck/shared';
import { PluginStore } from './store.js';
import { startLocalServer } from '../service.js';

it('advertises a single full list and optional direct discovery with the current attempt token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-tool-prompt-'));
  let service: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  try {
    const source = join(root, 'source'); await mkdir(join(source, '.dutydeck-plugin'), { recursive: true });
    await writeFile(join(source, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name: 'prompt-fixture', providers: 'index.mjs' }));
    await writeFile(join(source, 'index.mjs'), `export default api => api.registerQuery({name:'read',description:'Read',version:'1',inputSchema:{type:'object',properties:{},additionalProperties:false},resource:()=>'*',execute:async()=>null});`);
    await new PluginStore(root).install(source, { yes: true });
    const database = join(root, 'dutydeck.db'); createRepositories(database, { newDatabaseAuthority: 'ledger_v1' }).close();
    const port = await new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address() as { port: number }; server.close(error => error ? reject(error) : resolve(address.port)); }); });
    service = await startLocalServer({ webRoot: root, env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', DUTYDECK_HOST: '127.0.0.1', DUTYDECK_PORT: String(port), DUTYDECK_DEFAULT_CWD: root, DUTYDECK_DATABASE_URL: database, DUTYDECK_AUTH: 'false', DUTYDECK_DISABLE_LARK_LISTENER: 'true', DUTYDECK_AGENTS_JSON: '[]' } });
    const options = (service.runtime as unknown as { options: RuntimeOptions }).options;
    vi.spyOn(service.runtime, 'getActiveTaskContext').mockReturnValue({ taskId: 'task', attemptId: 'attempt', actorId: 'installation_owner' });
    const session = { id: 'fixture', agentId: 'fake', cwd: root, state: 'idle', runId: 'r', createdAt: '', updatedAt: '', source: 'web' } as Session;
    const result = await options.sessionPrompt!(session, 'request'); const prompt = typeof result === 'string' ? result : result.prompt;
    expect(prompt).toMatch(/tool list --turn \S+/);
    expect(prompt).toContain('tool list --summary --turn <本轮凭证>');
    expect(prompt).toContain('tool describe <工具> --turn <本轮凭证>');
    expect(prompt).toContain('tool manual <工具> <ID> --turn <本轮凭证>');
    expect(prompt).toContain('必需 SOP 仍完整冻结');
    expect(prompt).toContain('同次重试保留 call-id');
  } finally { vi.restoreAllMocks(); await service?.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
