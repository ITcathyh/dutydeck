// Startup readiness gate and graceful-shutdown ordering:
//  - the exclusive-bind winner must not handle HTTP business while recovery
//    and worker startup are still running;
//  - stop() must finish in-flight worker chains (durable writes included)
//    before closing the store, so an overlapping restart sees consistent state.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../service/main.mjs';
import { JobStore } from '../service/store.mjs';
import { setupHarness, makeEnvelope, waitFor, apiMessage, APP, OTHER, type Harness } from './helpers/harness';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

let dir = '';
let svc: any;
let svcPromise: Promise<any> | undefined;
let h: Harness | undefined;
// Blockers injected into a test and force-released in teardown so a failed
// assertion cannot leave afterEach waiting on a blocked stop().
const releaseBlockers: Array<() => void> = [];

afterEach(async () => {
  while (releaseBlockers.length) releaseBlockers.pop()!();
  if (h) {
    await h.cleanup();
    h = undefined;
  } else {
    try { svc ??= await svcPromise; } catch { /* startup rejected */ }
    await svc?.stop?.().catch(() => {});
  }
  svc = undefined;
  svcPromise = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});

describe('startup readiness gate', () => {
  it('holds HTTP requests until recovery/initialization finishes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rvj-gate-'));

    let releaseRecovery: () => void = () => {};
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    releaseBlockers.push(releaseRecovery);
    const worker = {
      recoverInFlightReplies: vi.fn(() => recoveryGate),
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    const config = {
      dataDir: dir,
      listen: { host: '127.0.0.1', port: 0, path: '/lark/events' },
    };

    svcPromise = createService(config as any, {
      worker: worker as any,
      lark: {} as any,
      sender: {} as any,
      logger: silent,
    });

    // Discovery is published from the listen callback: bind is won while the
    // blocked recovery is still pending.
    const discoveryPath = join(dir, 'service.json');
    await waitFor(() => existsSync(discoveryPath), { timeout: 5_000, label: 'discovery file' });
    const info = JSON.parse(await readFile(discoveryPath, 'utf8'));

    const responsePromise = fetch(`http://127.0.0.1:${info.port}/healthz`);
    const answeredEarly = await Promise.race([
      responsePromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    expect(answeredEarly).toBe(false);
    expect(worker.start).not.toHaveBeenCalled();

    releaseRecovery();
    svc = await svcPromise;
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true });
  }, 15_000);
});

describe('graceful shutdown drains in-flight work', () => {
  it('service.stop() waits for a blocked outbound send and flushes the durable final status', async () => {
    h = await setupHarness();
    const sourceKey = `lark/${APP}/om_stop_drain`;

    // A non-commander real user gets an explanatory denial reply. Block the
    // real fake-Lark send so the worker chain stays in flight.
    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    releaseBlockers.push(releaseSend);
    const sender = h.svc.sender;
    const originalSend = sender.send.bind(sender);
    h.svc.sender.send = async (args: unknown) => {
      await sendGate;
      return originalSend(args);
    };

    const res = await h.post(makeEnvelope({
      eventId: 'ev_stop_drain',
      messageId: 'om_stop_drain',
      openId: OTHER,
    }));
    expect(res.status).toBe(200);

    await waitFor(
      () => h!.svc.store.getJob(sourceKey)?.replies?.denial?.status === 'sending',
      { timeout: 6_000, label: 'denial in sending state' },
    );

    let stopped = false;
    const stopPromise = h.svc.stop().then(() => { stopped = true; });

    // Correct ordering cannot resolve stop before the blocked worker chain.
    const early = await Promise.race([
      stopPromise.then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 250)),
    ]);
    expect(early).toBe('waiting');
    expect(stopped).toBe(false);

    releaseSend();
    await stopPromise;

    // stop() closed the store last; reopening the file shows the final write.
    const reopened = await JobStore.open(h.dir);
    try {
      expect(reopened.getJob(sourceKey).replies.denial.status).toBe('sent');
    } finally {
      await reopened.close();
    }
  }, 20_000);

  it('delivers the receipt of an HTTP request in flight when stop() starts, then drains its kick', async () => {
    h = await setupHarness();

    // Block the inbox transaction so the POST is still in handler when stop.
    let releaseMutate: () => void = () => {};
    const mutateGate = new Promise<void>((resolve) => { releaseMutate = resolve; });
    releaseBlockers.push(releaseMutate);
    const realMutate = h.svc.store.mutate.bind(h.svc.store);
    let mutateEntered = false;
    h.svc.store.mutate = (fn: unknown) => {
      mutateEntered = true;
      return mutateGate.then(() => realMutate(fn));
    };

    const postPromise = h.post(makeEnvelope({
      eventId: 'ev_stop_http',
      messageId: 'om_stop_http',
      parentId: 'om_fwd_stop',
      threadId: 'omt_1',
      rootId: 'om_root',
    }));
    h.lark.messages.set('om_fwd_stop', apiMessage({
      messageId: 'om_fwd_stop', text: '关停排空材料', threadId: 'omt_1', rootId: 'om_root',
    }));
    await waitFor(() => mutateEntered, { timeout: 5_000, label: 'inbox mutate entered' });

    let stopped = false;
    const stopPromise = h.svc.stop().then(() => { stopped = true; });
    const early = await Promise.race([
      stopPromise.then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 250)),
    ]);
    expect(early).toBe('waiting');
    expect(stopped).toBe(false);

    releaseMutate();
    const response = await postPromise;
    expect(response.status).toBe(200);
    expect(response.body.decision).toBe('stop');

    await stopPromise;
    expect(stopped).toBe(true);
    // The detached kick ran and reached the fake pairfob exactly once.
    await waitFor(() => h!.hub()?.submitCount === 1, { timeout: 8_000, label: 'one submit after drain' });
  }, 20_000);

  it('drain 期间继续独占固定端口：新业务得可重投 503、第二实例 EADDRINUSE；stop 完成后端口才释放', async () => {
    h = await setupHarness();
    const port = h.svc.address.port;
    const fixedConfig = { ...h.config, listen: { ...h.config.listen, port } };
    const sourceKey = `lark/${APP}/om_port_hold`;

    // Keep one worker chain blocked inside outbound delivery so stop() stays in
    // the worker-drain phase while the listening handle must remain bound.
    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    releaseBlockers.push(releaseSend);
    const sender = h.svc.sender;
    const originalSend = sender.send.bind(sender);
    h.svc.sender.send = async (args: unknown) => {
      await sendGate;
      return originalSend(args);
    };

    await h.post(makeEnvelope({ eventId: 'ev_port_hold', messageId: 'om_port_hold', openId: OTHER }));
    await waitFor(
      () => h!.svc.store.getJob(sourceKey)?.replies?.denial?.status === 'sending',
      { timeout: 6_000, label: 'denial in sending state' },
    );

    const stopped: string[] = [];
    const stopPromise = h.svc.stop().then(() => stopped.push('stopped'));

    // The still-bound listener explicitly refuses new business as retryable.
    const retryRes = await fetch(`http://127.0.0.1:${port}/lark/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(retryRes.status).toBe(503);
    const retryBody = await retryRes.json();
    expect(retryBody.error).toMatchObject({ code: 'shutting_down', retryable: true });

    // A second generation cannot take the fixed port during the overlap window.
    await expect(createService(fixedConfig as any, { logger: silent }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(stopped).toHaveLength(0);

    releaseSend();
    await stopPromise;

    // Only after full drain is the port released and a new generation allowed.
    const svc2 = await createService(fixedConfig as any, { logger: silent });
    try {
      expect(svc2.address.port).toBe(port);
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await svc2.stop();
    }
  }, 25_000);
});
