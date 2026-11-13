import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { readLarkConfigs } from '../lark/config.js';

interface FirstRunGuidanceOptions {
  address: string;
  databaseUrl: string;
  json?: boolean;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
  hasBotConfiguration?: (databaseUrl: string) => Promise<boolean>;
  cliOnPath?: () => boolean;
}

function executableOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const names = process.platform === 'win32' ? [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command] : [command];
  const path = env.PATH ?? (process.platform === 'win32' ? '' : '/usr/bin:/bin');
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return true;
      } catch {}
    }
  }
  return false;
}

async function hasAnyBotConfiguration(databaseUrl: string): Promise<boolean> {
  const repositories = createRepositories(databaseUrl);
  try {
    if ((await repositories.channelBots.list()).length > 0) return true;
    return (await readLarkConfigs(repositories.config, { readOnly: true })).length > 0;
  } finally {
    repositories.close();
  }
}

/** Print only on an interactive foreground serve with no readable bot configuration. */
export async function maybePrintFirstRunGuidance(options: FirstRunGuidanceOptions): Promise<void> {
  const env = options.env ?? process.env;
  if (options.json === true || options.isTTY !== true || env.DUTYDECK_DAEMONIZED === '1') return;
  try {
    const hasBots = await (options.hasBotConfiguration ?? hasAnyBotConfiguration)(options.databaseUrl);
    if (hasBots) return;
    const lines = [
      'Next steps:',
      '  Configure a Lark bot: dutydeck setup',
      '  Check the installation: dutydeck doctor',
      `  Open the Web console: ${options.address}`
    ];
    if (!(options.cliOnPath ?? (() => executableOnPath('dutydeck', env)))()) {
      lines.push(
        'The dutydeck command is not on PATH. Add your package manager\'s global executable directory to PATH (for pnpm, run `pnpm setup` and restart the terminal), or invoke `pnpm dlx @byted/dutydeck <command>` / `npx @byted/dutydeck <command>`.'
      );
    }
    (options.write ?? (text => process.stdout.write(text)))(`${lines.join('\n')}\n`);
  } catch {
    // Guidance is best-effort; a database or terminal write problem must not stop the server.
  }
}
