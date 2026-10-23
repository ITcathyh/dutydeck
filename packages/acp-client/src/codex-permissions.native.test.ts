import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createRuntimeStore } from 'acpx/runtime';
import type { PermissionMode } from '@dutydeck/shared';
import { AcpxAdapter } from './index.js';

// Explicit opt-in: this uses the installed native ACP bridge and real model.
const binary = process.env.DUTYDECK_NATIVE_CODEX_BINARY;
const entry = process.env.DUTYDECK_NATIVE_CODEX_ACP_ENTRY;
it.skipIf(!binary || !entry)('gates native Codex writes across rejection, approval, mode changes and restored sessions', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-codex-approval-native-'));
  const home = join(cwd, 'codex-home'); await mkdir(home);
  for (const name of ['auth.json', 'config.toml', 'models_cache.json']) {
    const source = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), name);
    if (existsSync(source)) await copyFile(source, join(home, name));
  }
  const workspace = join(cwd, 'workspace'); await mkdir(workspace);
  const key = 'native-codex-approval';
  const store = createRuntimeStore({ stateDir: join(workspace, '.dutydeck', 'acpx') });
  let adapter: AcpxAdapter | undefined;
  let nativeId: string | undefined;
  try {
    for (const [mode, approve] of [['ask', false], ['ask', true], ['approve-reads', false], ['full-trust', true], ['ask', false]] as const) {
      const file = `write-${mode}-${approve}-${nativeId ? 'restored' : 'created'}.txt`;
      const target = join(workspace, file);
      const events: any[] = [];
      let beforeApproval: boolean | undefined;
      adapter = new AcpxAdapter({ id: 'codex-acp', name: 'Native Codex', command: process.execPath, args: [entry!], protocol: 'acp', cwd: workspace,
        env: { CODEX_HOME: home, CODEX_PATH: binary! }, model: 'gpt-6.1-sol', permissionMode: mode as PermissionMode, timeout: 120,
        capabilities: { pause: false, resume: true }, builtin: true }, { sessionKey: key, onEvent: event => {
          events.push(event);
          if (event.type === 'permission_request' && event.data.status === 'pending') {
            beforeApproval = existsSync(target);
            queueMicrotask(() => { void adapter!.resolvePermission(String(event.data.id), approve); });
          }
        } });
      await adapter.start();
      if (!nativeId) {
        await adapter.send('Run exactly the safe read-only shell command pwd once, then report the directory. Do not use any other tools.');
        // The installed native Codex also escalates this shell read in ask mode.
        expect(events.some(event => event.type === 'permission_request' && event.data.status === 'pending')).toBe(true);
        expect(events.some(event => event.type === 'tool_call')).toBe(true);
        events.length = 0;
      }
      await adapter.send(`Run exactly one shell command: printf DD_CODEX_APPROVAL > ${file} . Do not use other tools or retry if denied. Report the result.`);
      const requested = events.some(event => event.type === 'permission_request' && event.data.status === 'pending');
      expect(requested).toBe(mode !== 'full-trust');
      if (requested) expect(beforeApproval).toBe(false);
      expect(existsSync(target)).toBe(approve);
      if (approve) expect(await readFile(target, 'utf8')).toBe('DD_CODEX_APPROVAL');
      const record = (await store.load(key))!;
      expect(Object.keys(record.acpx?.session_options?.env ?? {}).every(name => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name))).toBe(true);
      if (nativeId) expect(record.acpSessionId).toBe(nativeId);
      nativeId = record.acpSessionId;
      await adapter.stop(); adapter = undefined;
    }
  } finally { await adapter?.stop(); await rm(cwd, { recursive: true, force: true }); }
}, 300_000);
