import { z } from 'zod';
import { RuntimeError, type ConfigRepository } from '@dutydeck/shared';
import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { herdrControlEnvironment } from '@dutydeck/session-backends';

export const terminalBackendSchema = z.enum(['tmux', 'herdr']);
export const terminalSettingsKey = 'dutydeck.terminal_backend';
export function primaryHerdrBinary(env: NodeJS.ProcessEnv = process.env): string {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const binary = resolve(directory, 'herdr');
    try { accessSync(binary, constants.X_OK); return binary; } catch { /* next PATH entry */ }
  }
  throw new RuntimeError('HERDR_UNAVAILABLE', 'Herdr 未安装；请安装 Herdr >= 0.9，或选择 tmux。不会自动回退。', 503);
}
export class TerminalSettings {
  constructor(private readonly config: ConfigRepository, private readonly env: NodeJS.ProcessEnv = process.env) {}
  async current(): Promise<'tmux' | 'herdr'> { return terminalBackendSchema.parse(await this.config.get(terminalSettingsKey) ?? 'tmux'); }
  async get() { return { terminalBackend: await this.current(), scope: 'pty-cli' as const }; }
  async set(body: unknown) {
    const { terminalBackend } = z.object({ terminalBackend: terminalBackendSchema }).strict().parse(body);
    if (terminalBackend === 'herdr') {
      const binary = primaryHerdrBinary(this.env);
      let version: string;
      try { version = execFileSync(binary, ['--version'], { encoding: 'utf8', env: herdrControlEnvironment(this.env), timeout: 3000 }).trim(); }
      catch { throw new RuntimeError('HERDR_UNAVAILABLE', '无法执行 Herdr；不会自动回退到 tmux。', 503); }
      if (!/^herdr 0\.(?:9|[1-9]\d)\./.test(version) || process.platform !== 'linux') throw new RuntimeError('HERDR_UNAVAILABLE', 'Herdr 主终端需要 Linux 和 Herdr >= 0.9。', 503);
    }
    await this.config.set(terminalSettingsKey, terminalBackend);
    return this.get();
  }
}
