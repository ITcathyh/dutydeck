// Startup configuration contract for config.json:
//  - listen.host is loopback-only;
//  - pairfob.bin + project token file + Lark appSecret are required and their
//    absence must throw a locatable, key-named error before the service binds;
//  - the 4000 code point limits can only be lowered;
//  - the all-bot commander setting uses a JSON boolean.
//
// These run through the real loadConfig (the main.mjs entry), not createService
// with injected object configs, so the operator-facing startup path is covered.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, isLoopbackHost } from '../service/config.mjs';

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MAIN = join(PLUGIN_ROOT, 'service', 'main.mjs');

let dir = '';
let child: ChildProcess | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});

async function setupDir() {
  dir = await mkdtemp(join(tmpdir(), 'rvj-config-'));
  const tokenFile = join(dir, 'project.token');
  await writeFile(tokenFile, 'project-token-value', { mode: 0o600 });
  return tokenFile;
}

function baseRaw(tokenFile: string, over: Record<string, any> = {}) {
  return {
    appId: 'cli_config_test',
    handlerToken: 'handler-bearer',
    appSecret: 'Lark-app-secret',
    allowedChatIds: ['oc_dispatch'],
    commanderOpenIds: ['ou_boss'],
    listen: { host: '127.0.0.1', port: 14517, path: '/lark/events' },
    pairfob: { bin: process.execPath, project: 'rovetap', tokenFile },
    ...over,
  };
}

async function writeConfig(raw: any) {
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(raw));
  return configPath;
}

describe('rovetap-jobs startup config: loopback host', () => {
  it('classifies only loopback hosts as allowed', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('[2001:db8::1]')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });

  it('rejects a non-loopback listen.host with a key-locatable message', async () => {
    const tokenFile = await setupDir();
    const configPath = await writeConfig(baseRaw(tokenFile, {
      listen: { host: '0.0.0.0', port: 14517 },
    }));
    await expect(loadConfig(configPath)).rejects.toThrow(/listen\.host/);
    await expect(loadConfig(configPath)).rejects.toThrow(/回环/);
  });
});

describe('rovetap-jobs startup config: all-bot commanders', () => {
  it.each([undefined, false, true])('loads allowAllBotCommanders=%s as a boolean', async value => {
    const tokenFile = await setupDir();
    const config = await loadConfig(await writeConfig(baseRaw(tokenFile, { allowAllBotCommanders: value })));
    expect(config.allowAllBotCommanders).toBe(value === true);
  });

  it.each(['true', 1, null])('rejects a non-boolean allowAllBotCommanders=%s', async value => {
    const tokenFile = await setupDir();
    const configPath = await writeConfig(baseRaw(tokenFile, { allowAllBotCommanders: value }));
    await expect(loadConfig(configPath)).rejects.toThrow(/allowAllBotCommanders.*布尔值/u);
  });

  it('parses a fixed supplemental cutoff and leaves it unset otherwise', async () => {
    const tokenFile = await setupDir();
    const raw = baseRaw(tokenFile, { allowAllBotCommanders: true });
    const configPath = await writeConfig(raw);
    expect((await loadConfig(configPath)).additionalBotCommandsSince).toBeUndefined();

    const cutoff = '2026-11-26T11:04:00.123+08:00';
    await writeConfig({ ...raw, additionalBotCommandsSince: cutoff });
    const expected = Date.UTC(2026, 10, 26, 3, 4, 0, 123);
    expect((await loadConfig(configPath)).additionalBotCommandsSince).toBe(expected);
    expect((await loadConfig(configPath)).additionalBotCommandsSince).toBe(expected);
  });

  it.each([undefined, false])('rejects a cutoff when allowAllBotCommanders=%s', async allowAllBotCommanders => {
    const tokenFile = await setupDir();
    const configPath = await writeConfig(baseRaw(tokenFile, {
      allowAllBotCommanders, additionalBotCommandsSince: '2026-11-26T03:04:00Z',
    }));
    await expect(loadConfig(configPath)).rejects.toThrow(/additionalBotCommandsSince.*allowAllBotCommanders/u);
  });

  it.each([null, 1764000060000, '2026-11-26', '2026-11-26T03:04:00', '2026-02-30T03:04:00Z'])('rejects an invalid cutoff %s', async value => {
    const tokenFile = await setupDir();
    const configPath = await writeConfig(baseRaw(tokenFile, {
      allowAllBotCommanders: true, additionalBotCommandsSince: value,
    }));
    await expect(loadConfig(configPath)).rejects.toThrow(/additionalBotCommandsSince.*ISO 8601/u);
  });
});

describe('rovetap-jobs startup config: required integrations', () => {
  it('loads a complete config and defaults both entry limits to 4000', async () => {
    const tokenFile = await setupDir();
    const config = await loadConfig(await writeConfig(baseRaw(tokenFile)));
    expect(config.listen.host).toBe('127.0.0.1');
    expect(config.pairfob.bin).toBe(process.execPath);
    expect(config.limits.maxInstructionChars).toBe(4000);
    expect(config.limits.maxMaterialChars).toBe(4000);
  });

  it('clamps limits above the upstream 4000 ceiling but keeps smaller values', async () => {
    const tokenFile = await setupDir();
    const config = await loadConfig(await writeConfig(baseRaw(tokenFile, {
      limits: { maxInstructionChars: 99_999, maxMaterialChars: 50_000, threadScan: 12 },
    })));
    expect(config.limits.maxInstructionChars).toBe(4000);
    expect(config.limits.maxMaterialChars).toBe(4000);
    expect(config.limits.threadScan).toBe(12);

    const tokenFile2 = join(dir, 'project2.token');
    await writeFile(tokenFile2, 't2');
    const small = await loadConfig(await writeConfig(baseRaw(tokenFile2, {
      limits: { maxInstructionChars: 800, maxMaterialChars: 1200 },
    })));
    expect(small.limits.maxInstructionChars).toBe(800);
    expect(small.limits.maxMaterialChars).toBe(1200);
  });

  it('requires pairfob.bin and names the key', async () => {
    const tokenFile = await setupDir();
    const raw = baseRaw(tokenFile);
    delete raw.pairfob.bin;
    await expect(loadConfig(await writeConfig(raw))).rejects.toThrow(/pairfob\.bin/);
  });

  it('rejects a relative pairfob.bin path', async () => {
    const tokenFile = await setupDir();
    const raw = baseRaw(tokenFile);
    raw.pairfob.bin = 'usr/local/bin/pairfob';
    await expect(loadConfig(await writeConfig(raw))).rejects.toThrow(/pairfob\.bin 必须是绝对路径/);
  });

  it('requires the pairfob project token file and names the key', async () => {
    const tokenFile = await setupDir();
    const previous = process.env.ROVETAP_PROJECT_TOKEN_FILE;
    delete process.env.ROVETAP_PROJECT_TOKEN_FILE;
    try {
      const raw = baseRaw(tokenFile);
      delete raw.pairfob.tokenFile;
      await expect(loadConfig(await writeConfig(raw))).rejects.toThrow(/pairfob\.tokenFile/);
    } finally {
      if (previous !== undefined) process.env.ROVETAP_PROJECT_TOKEN_FILE = previous;
    }
  });

  it('reports a missing token file as a locatable pairfob.tokenFile failure', async () => {
    const tokenFile = await setupDir();
    const raw = baseRaw(tokenFile);
    raw.pairfob.tokenFile = join(dir, 'does-not-exist.token');
    await expect(loadConfig(await writeConfig(raw))).rejects.toThrow(/pairfob\.tokenFile/);
  });

  it('requires the Lark appSecret used to read material', async () => {
    const tokenFile = await setupDir();
    const raw = baseRaw(tokenFile);
    delete raw.appSecret;
    await expect(loadConfig(await writeConfig(raw))).rejects.toThrow(/appSecret/);
  });

  it('wraps an unreadable appSecretFile with the config key and path', async () => {
    const tokenFile = await setupDir();
    const raw = baseRaw(tokenFile);
    delete raw.appSecret;
    raw.appSecretFile = './missing-secret';
    await expect(loadConfig(await writeConfig(raw))).rejects.toThrow(/appSecretFile/);
  });

  it('main.mjs exits 1 with the locatable reason instead of running silently', async () => {
    const tokenFile = await setupDir();
    const configPath = await writeConfig(baseRaw(tokenFile, {
      listen: { host: '0.0.0.0', port: 14518 },
    }));

    let stderr = '';
    const exitCode = await new Promise<number | null>((resolve) => {
      child = spawn(process.execPath, [MAIN, '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      const timer = setTimeout(() => { child?.kill('SIGKILL'); resolve(null); }, 10_000);
      child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });

    expect(exitCode, `stderr=${stderr}`).toBe(1);
    expect(stderr).toMatch(/\[rovetap-jobs\] failed to start:.*listen\.host/);
  }, 15_000);
});
