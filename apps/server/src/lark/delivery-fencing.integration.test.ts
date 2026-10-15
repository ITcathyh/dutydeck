import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { deliveryCoordinator } from './delivery-coordinator.fixture.js';
import { performLarkCardReconcile } from './reconciler.js';
import { createLarkCardService } from './service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const temp = async () => { const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-delivery-')); cleanups.push(() => rm(cwd, { recursive: true, force: true })); return cwd; };

it.each(['process', 'result'])('coordinator.stop invalidates a %s write before an internal 429 retry', async kind => {
  const cwd = await temp();
  let h: Awaited<ReturnType<typeof deliveryCoordinator>>;
  let attempts = 0, armed = false;
  h = await deliveryCoordinator(cwd, (async (url: string, init: RequestInit) => {
    if (url.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'synthetic', expire: 7200 });
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (h && (kind === 'process' ? armed && init.method === 'PATCH' : body.uuid?.startsWith('result_'))) {
      attempts++;
      if (attempts === 1) { h.coordinator.stop(); return Response.json({ code: 230020 }, { status: 429 }); }
    }
    return Response.json({ code: 0, data: { message_id: 'om_process', image_key: 'img_fixture', reaction_id: 'reaction' } });
  }) as typeof fetch);
  cleanups.push(() => h.close());
  await vi.waitFor(() => expect(h.ready()).toBe(true));
  armed = true; h.finish();
  await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(attempts).toBe(1);
});

it('persists the first side-effect time across SIGKILL before a provider response and expires restart delivery', async () => {
  const cwd = await temp();
  const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', fileURLToPath(new URL('./delivery-coordinator.fixture.ts', import.meta.url)), '--crash-child', cwd], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } });
  const accepted = await new Promise<string>((resolve, reject) => {
    child.stdout.on('data', data => { if (String(data).startsWith('accepted:')) resolve(String(data).trim().slice(9)); });
    child.once('exit', () => reject(new Error(`child exited before acceptance: ${stderr}`)));
  });
  child.kill('SIGKILL'); await once(child, 'exit');
  const repos = createRepositories(`${cwd}/state.db`); cleanups.push(async () => repos.close());
  const mapping = (await repos.channelMappings.list('lark-card:cli_delivery_fixture'))[0]!;
  const saved = JSON.parse(mapping.extra!);
  expect(await repos.config.get(`lark.delivery.${accepted}.summary`)).toBeUndefined();
  const firstAt = saved.final_delivery_first_failed_at ?? Date.now();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(firstAt + 2 * 60 * 60_000);
  let sends = 0;
  const service = createLarkCardService({ LARK_APP_ID: 'cli_restart_delivery', LARK_APP_SECRET: 'synthetic' }, (async (url: string) => {
    if (url.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'synthetic', expire: 7200 });
    sends++; return Response.json({ code: 0, data: { message_id: 'om_duplicate' } });
  }) as typeof fetch); cleanups.push(async () => service.close());
  const task = (await repos.tasks.listBySession(mapping.sessionId))[0]!;
  await performLarkCardReconcile({ runtime: { getTasks: async () => [task], getEvents: async () => [{ id: 'final', type: 'text', data: { text: 'synthetic final answer' } }] } as any,
    service, cardMappings: repos.channelMappings, deliveryStore: repos.config,
    log: { info() {}, warn() {}, error() {} }, channel: 'lark-card:cli_delivery_fixture', config: { appId: 'cli_delivery_fixture' } as any });
  expect(sends).toBe(0);
  expect(saved.final_delivery_first_failed_at).toEqual(expect.any(Number));
  expect(JSON.parse((await repos.channelMappings.get(mapping.channel, mapping.externalId))!.extra!)).toMatchObject({ state: 'completed', final_delivery_state: 'failed' });
}, 30_000);

it.each(['stop', 'replace-turn'])('fences an in-flight real coordinator reconciliation after %s without requiring an active task', async action => {
  const cwd = await temp();
  let h: Awaited<ReturnType<typeof deliveryCoordinator>>, replay = false, writes = 0;
  h = await deliveryCoordinator(cwd, (async (url, init) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'synthetic', expire: 7200 });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (replay && body.uuid?.startsWith('result_')) {
      writes++;
      if (action === 'stop') h.coordinator.stop();
      else {
        const row = (await h.repos.channelMappings.list('lark-card:cli_delivery_fixture'))[0]!;
        const saved = JSON.parse(row.extra!);
        await h.repos.channelMappings.save({ ...row, extra: JSON.stringify({ ...saved, turn: saved.turn + 1 }) });
      }
      return Response.json({ code: 230020 }, { status: 429 });
    }
    return Response.json({ code: 0, data: { message_id: body.uuid?.startsWith('result_') ? 'om_result' : 'om_process', image_key: 'img_fixture', reaction_id: 'reaction' } });
  }) as typeof fetch); cleanups.push(() => h.close());
  await vi.waitFor(() => expect(h.ready()).toBe(true)); h.finish();
  await vi.waitFor(async () => expect(JSON.parse((await h.repos.channelMappings.list('lark-card:cli_delivery_fixture'))[0]!.extra!).final_message_id).toBe('om_result'));
  const row = (await h.repos.channelMappings.list('lark-card:cli_delivery_fixture'))[0]!;
  const saved = JSON.parse(row.extra!);
  // Replay a frozen historical terminal mapping with no active runtime task or result receipt.
  await h.repos.config.set(`lark.delivery.${(await import('./result-delivery.js')).larkResultKey('om_process')}.summary`, '');
  await h.repos.channelMappings.save({ ...row, extra: JSON.stringify({ ...saved, final_message_id: undefined, final_delivery_state: undefined }) });
  expect(h.runtime.getActiveTaskContext(row.sessionId)).toBeUndefined();
  replay = true;
  await h.coordinator.reconcile(h.config);
  expect(writes).toBe(1);
  const after = JSON.parse((await h.repos.channelMappings.get(row.channel, row.externalId))!.extra!);
  expect(after.final_message_id).toBeUndefined();
  if (action === 'replace-turn') expect(after.turn).toBe(saved.turn + 1);
});

it('real coordinator persists audit failure immediately and restart never repeats the result or fixed notice', async () => {
  const cwd = await temp(); let resultWrites = 0, notices = 0;
  const h = await deliveryCoordinator(cwd, (async (url, init) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'synthetic', expire: 7200 });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (body.uuid?.startsWith('result_')) { resultWrites++; return Response.json({ code: 230028, msg: 'audit rejected' }, { status: 400 }); }
    if (body.uuid?.startsWith('audit_')) { notices++; expect(body.content).not.toContain('synthetic final answer'); }
    return Response.json({ code: 0, data: { message_id: 'om_fixture', image_key: 'img_fixture', reaction_id: 'reaction' } });
  }) as typeof fetch); cleanups.push(() => h.close());
  await vi.waitFor(() => expect(h.ready()).toBe(true)); h.finish();
  await vi.waitFor(async () => expect(JSON.parse((await h.repos.channelMappings.list('lark-card:cli_delivery_fixture'))[0]!.extra!)).toMatchObject({ state: 'completed', final_delivery_state: 'failed' }));
  await h.coordinator.reconcile(h.config); await h.coordinator.reconcile(h.config);
  expect(resultWrites).toBe(1); expect(notices).toBe(1);
});
