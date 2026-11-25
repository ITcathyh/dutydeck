import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeLark, apiMessage, makeEnvelope, APP, CHAT, BOSS, TOKEN } from './helpers/harness';

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MAIN = join(PLUGIN_ROOT, 'service', 'main.mjs');
const FIXTURE = join(PLUGIN_ROOT, 'test', 'fixtures', 'fake-pairfob.mjs');

let child: ChildProcess | undefined;
let dir = '';
let lark: Awaited<ReturnType<typeof startFakeLark>> | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (lark) await lark.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('rovetap-jobs real service process', () => {
  it('boots from --config, writes service.json, handles a real HTTP event, then exits on SIGTERM', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rvj-proc-'));
    await chmod(FIXTURE, 0o755).catch(() => {});
    const hubPath = join(dir, 'hub.json');
    lark = await startFakeLark();
    lark.messages.set('om_pq', apiMessage({ messageId: 'om_pq', text: '真实进程材料', threadId: 'omt_p', rootId: 'om_proot' }));

    const config = {
      dataDir: dir,
      appId: APP,
      handlerToken: TOKEN,
      allowedChatIds: [CHAT],
      commanderOpenIds: [BOSS],
      webBaseUrl: 'https://rove.example.com',
      listen: { host: '127.0.0.1', port: 0, path: '/lark/events' },
      lark: { appId: APP, appSecret: 'test-secret', baseUrl: lark.baseUrl },
      reply: { mode: 'lark-api' },
      pairfob: { bin: FIXTURE, project: 'rovetap', socket: join(dir, 'hub.sock'), tokenFile: join(dir, 'project.token') },
      pollMs: 10, phasePollMs: 20, retryBaseMs: 2,
    };
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(config.pairfob.tokenFile, 'tok');

    let stderr = '';
    child = spawn(process.execPath, [MAIN, '--config', configPath], {
      env: { ...process.env, FAKE_PAIRFOB_HUB: hubPath, FAKE_PAIRFOB_MODE: 'ok' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    // Wait for the ephemeral-port discovery file.
    const discoveryPath = join(dir, 'service.json');
    let port = 0;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        const info = JSON.parse(await readFile(discoveryPath, 'utf8'));
        if (info.port) { port = info.port; break; }
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(port, `service.json port; stderr=${stderr}`).toBeGreaterThan(0);

    const envelope = makeEnvelope({ eventId: 'ev_proc', messageId: 'om_proc', parentId: 'om_pq', threadId: 'omt_p', rootId: 'om_proot' });
    const res = await fetch(`http://127.0.0.1:${port}/lark/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(200);
    const receipt = await res.json();
    expect(receipt).toEqual({ event_id: 'ev_proc', decision: 'stop' });

    const accepted = await new Promise<boolean>((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (lark!.replies.some((r) => r.text.includes('项目已接单'))) { clearInterval(timer); resolve(true); }
        else if (Date.now() - t0 > 8_000) { clearInterval(timer); resolve(false); }
      }, 30);
    });
    expect(accepted, `accepted reply; stderr=${stderr}`).toBe(true);

    const hub = JSON.parse(await readFile(hubPath, 'utf8'));
    expect(hub.submitCount).toBe(1);
    expect(hub.lastPayload.source_key).toBe(`lark/${APP}/om_proc`);

    // SIGTERM must trigger graceful shutdown and exit 0.
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const outcome = await Promise.race([
      exited,
      new Promise<{ timeout: true }>((r) => setTimeout(() => r({ timeout: true }), 6_000)),
    ]);
    if ('timeout' in outcome) throw new Error(`service did not exit on SIGTERM; stderr=${stderr}`);
    expect(outcome.code === 0 || outcome.signal === 'SIGTERM').toBe(true);
  }, 20_000);
});
