import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import { agentConfigSchema } from '@dutydeck/shared';
import { PtyCliDriver } from './driver.js';

it.each(['linux', 'darwin', 'win32'])('limits the native discovery retirement gate to Linux (%s)', async platform => {
  const cwd = mkdtempSync(join(tmpdir(), 'dd-retirement-platform-'));
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const identify = vi.fn(), observe = vi.fn();
  const driver = new PtyCliDriver({ sessionId: 'ses_platform',
    agent: agentConfigSchema.parse({ id: 'claude-code', name: 'fixture', command: 'unused', args: [], cwd, env: {}, protocol: 'pty-cli', permissionMode: 'full-trust', capabilities: { resume: true } }),
    adapter: createCliAdapter('claude-code'), processProbe: { identify, observe }, onEvent() {}, onExit() {} });
  try {
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    // No native observation exists yet. Linux must preserve rather than trust
    // an undiscovered dialect; other platforms keep the prior marker rules.
    expect(await driver.prepareForIdleRetirement()).toBe(platform !== 'linux');
    expect(identify).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, 'platform', original);
    await driver.stop(); rmSync(cwd, { recursive: true, force: true });
  }
});
