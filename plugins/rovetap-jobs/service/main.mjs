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
  await mkdir(config.dataDir, { recursive: true });
  const store = deps.store ?? await JobStore.open(config.dataDir);
  const lark = deps.lark ?? new LarkApiClient(config.lark, deps.fetch);
  const sender = deps.sender ?? new ReplySender(config, lark);
  const worker = deps.worker ?? new JobWorker({ config, store, sender, lark, logger: deps.logger ?? console });
  await worker.recoverInFlightReplies();
  worker.start();

  const server = createEventServer({ config, store, worker });
  const discoveryFile = join(config.dataDir, 'service.json');
  const address = await listenWithDiscovery(
    server,
    { host: config.listen.host, port: config.listen.port, handlerPath: config.listen.path },
    discoveryFile,
    writeJsonAtomic,
  );

  return {
    config, store, lark, sender, worker, server, address,
    url: `http://${address.host === '0.0.0.0' ? '127.0.0.1' : address.host}:${address.port}${config.listen.path}`,
    async stop() {
      worker.stop();
      await new Promise((resolve) => server.close(resolve)).catch(() => {});
      await store.close();
    },
  };
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
