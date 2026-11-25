// Bootstrap for the rovetap-jobs plugin service.
//
// Real host-supervised run:
//   node service/main.mjs
//     -> config from $DUTYDECK_PLUGIN_DATA/config.json, state in same dir.
// Isolated scenario:
//   node service/main.mjs --config /tmp/.../config.json
//
// `createService(config)` is also used by vitest to drive the real HTTP stack
// against a temporary data dir, fake Lark base URL and fake pairfob executable.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverConfigPath, loadConfig } from './config.mjs';
import { JobStore, writeJsonAtomic } from './store.mjs';
import { LarkApiClient } from './lark-api.mjs';
import { ReplySender } from './reply.mjs';
import { JobWorker } from './worker.mjs';
import { createEventServer, listenWithDiscovery } from './server.mjs';

export async function createService(config, deps = {}) {
  // Mutable handler dependencies: the HTTP server is bound before the store
  // and worker exist, and requests wait on `ready` until these are filled.
  const handlerDeps = { config, store: deps.store ?? null, worker: deps.worker ?? null };
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Avoid an unhandled rejection when startup fails and no request is waiting.
  ready.catch(() => {});
  handlerDeps.ready = ready;

  const server = createEventServer(handlerDeps);
  const discoveryFile = join(config.dataDir, 'service.json');

  // 1) Exclusive loopback bind first. During a host restart two generations
  //    can race the same fixed port; the loser must stop here, before reading
  //    or rewriting in-flight state, starting a worker, or sending anything.
  const address = await listenWithDiscovery(
    server,
    { host: config.listen.host, port: config.listen.port, handlerPath: config.listen.path },
    discoveryFile,
    writeJsonAtomic,
  );

  // 2) Winner-only initialization. Incoming HTTP requests block on `ready`,
  //    so no business is handled until recovery and worker start are done.
  let store;
  const ownsStore = !deps.store;
  try {
    await mkdir(config.dataDir, { recursive: true });
    store = deps.store ?? await JobStore.open(config.dataDir);
    handlerDeps.store = store;
    const lark = deps.lark ?? new LarkApiClient(config.lark, deps.fetch);
    const sender = deps.sender ?? new ReplySender(config, lark);
    const worker = deps.worker ?? new JobWorker({ config, store, sender, lark, logger: deps.logger ?? console });
    handlerDeps.worker = worker;
    await worker.recoverInFlightReplies();
    worker.start();
    resolveReady();

    let stopPromise = null;
    const stop = () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        // Stop new connections, finish accepted requests' durable inbox write
        // and receipt (their detached worker.kick registers before the
        // response ends), then reap keep-alive sockets.
        await closeEventServer(server);
        // Stop polling and wait for all in-flight worker chains to persist
        // their final state before the store write chain is closed.
        await worker.stop();
        await store.close();
      })();
      return stopPromise;
    };

    return {
      config, store, lark, sender, worker, server, address,
      url: `http://${address.host === '0.0.0.0' ? '127.0.0.1' : address.host}:${address.port}${config.listen.path}`,
      stop,
    };
  } catch (error) {
    rejectReady(error);
    await closeServerAfterFailure(server);
    if (store && ownsStore) await store.close().catch(() => {});
    throw error;
  }
}

/**
 * Stop accepting new connections, wait until every request already tracked has
 * fully delivered its response, then reap idle keep-alive sockets and wait for
 * the server handle to close.
 */
async function closeEventServer(server) {
  const closed = new Promise((resolve) => { server.close(() => resolve()); });
  await server.drainInflight?.();
  server.closeIdleConnections?.();
  await closed;
}

/** Startup-failure cleanup: no request can be served, so release sockets. */
async function closeServerAfterFailure(server) {
  try {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  } catch { /* best effort */ }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const configPath = await discoverConfigPath();
    const config = await loadConfig(configPath);
    const service = await createService(config);
    process.stderr.write(`[rovetap-jobs] listening on ${service.url} (data=${config.dataDir})\n`);

    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stderr.write(`[rovetap-jobs] received ${signal}, shutting down\n`);
      try { await service.stop(); } catch { /* exit anyway */ }
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    process.stderr.write(`[rovetap-jobs] failed to start: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}
