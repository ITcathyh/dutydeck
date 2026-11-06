import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PTY_AGENT_CONTRIBUTIONS } from '../../pty-driver/src/contributions.js';

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixtureDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-version-probe-'));
  cleanup.push(directory);
  return directory;
}

/**
 * 每次被执行都在 log 里记一行参数；只认 `version` 子命令，前两种参数都失败，验证回退顺序不变。
 * 有延迟时另在目录的 timeline 里记开始与结束，用来判断几个命令是不是同时在跑。
 */
async function cli(directory: string, name: string, delaySeconds = 0) {
  const path = join(directory, name);
  const timeline = join(directory, 'timeline');
  await writeFile(path, `#!/bin/sh\necho "$*" >> "${path}.log"\n${delaySeconds ? `echo "begin ${name}" >> "${timeline}"\n/bin/sleep ${delaySeconds}\necho "end ${name}" >> "${timeline}"\n` : ''}[ "$1" = version ] || exit 2\necho "${name} 1.2.3"\n`, { mode: 0o755 });
  return path;
}
const invocations = async (path: string) => (await readFile(`${path}.log`, 'utf8').catch(() => '')).split('\n').filter(Boolean);

it('probes a CLI shared by ACP and terminal entries once per process', async () => {
  const directory = await fixtureDirectory();
  const codex = await cli(directory, 'custom-codex');
  vi.stubEnv('PATH', '');
  vi.stubEnv('CODEX_PATH', undefined);
  vi.resetModules();
  const { loadConfig } = await import('./index.js');
  const agents = loadConfig({ CODEX_PATH: codex, DUTYDECK_DEFAULT_CWD: directory }, PTY_AGENT_CONTRIBUTIONS).agents;
  for (const id of ['codex', 'codex-cli', 'codex-acp']) expect(agents.find(agent => agent.id === id)).toMatchObject({ version: 'custom-codex 1.2.3' });
  loadConfig({ CODEX_PATH: codex, DUTYDECK_DEFAULT_CWD: directory }, PTY_AGENT_CONTRIBUTIONS);
  // 一次完整的回退（--version、-V、version），不是每个入口各来一遍。
  expect(await invocations(codex)).toEqual(['--version', '-V', 'version']);
});

it('probes configured CLIs in parallel without blocking the event loop and returns the same config', async () => {
  const directory = await fixtureDirectory();
  const commands = await Promise.all(['slow-a', 'slow-b', 'slow-c'].map(name => cli(directory, name, 0.3)));
  const custom = commands.map((command, index) => ({ id: `slow-${index}`, name: `Slow ${index}`, command, protocol: 'acp' }));
  vi.stubEnv('PATH', '');
  vi.resetModules();
  const { loadConfigWithDiagnosticsAsync } = await import('./index.js');
  const env = { DUTYDECK_AGENTS_JSON: JSON.stringify(custom), DUTYDECK_DEFAULT_CWD: directory };
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  const loaded = await loadConfigWithDiagnosticsAsync(env);
  clearInterval(timer);
  // 同步 spawnSync 探测期间计时器一次都跑不了；串行时每个命令结束后下一个才开始。
  // 不按耗时判断：机器负载高时绝对时间不可靠。
  expect(ticks).toBeGreaterThan(0);
  const timeline = (await readFile(join(directory, 'timeline'), 'utf8')).split('\n').filter(Boolean);
  expect(timeline.slice(0, timeline.findIndex(line => line.startsWith('end '))).length).toBeGreaterThan(1);
  for (const [index, command] of commands.entries()) {
    expect(loaded.config.agents.find(agent => agent.id === `slow-${index}`)).toMatchObject({ command, version: `slow-${'abc'[index]} 1.2.3` });
    expect(await invocations(command)).toEqual(['--version', '-V', 'version']);
  }
  vi.resetModules();
  const { loadConfigWithDiagnostics } = await import('./index.js');
  expect(loaded).toEqual(loadConfigWithDiagnostics(env));
}, 20_000);

it('does not execute custom terminal wrappers to read a version', async () => {
  const directory = await fixtureDirectory();
  const wrapper = await cli(directory, 'wrapper');
  vi.stubEnv('PATH', '');
  vi.resetModules();
  const { loadConfigWithDiagnosticsAsync } = await import('./index.js');
  const loaded = await loadConfigWithDiagnosticsAsync({ DUTYDECK_DEFAULT_CWD: directory, DUTYDECK_AGENTS_JSON: JSON.stringify([{ id: 'wrapped', name: 'Wrapped', command: wrapper, protocol: 'pty-cli', adapterId: 'claude-code' }]) });
  expect(loaded.config.agents.find(agent => agent.id === 'wrapped')?.version).toBeUndefined();
  expect(await invocations(wrapper)).toEqual([]);
});
