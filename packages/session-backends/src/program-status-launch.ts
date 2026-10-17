import { fileURLToPath } from 'node:url';

/** Kept as a separate build entry alongside both the package and server bundle. */
export function programStatusCommand(bin: string, args: string[], enabled?: boolean): string[] {
  if (!enabled) return [bin, ...args];
  const relay = fileURLToPath(new URL(import.meta.url.endsWith('.ts')
    ? '../dist/program-status-relay.js' : './program-status-relay.js', import.meta.url));
  return [process.execPath, relay, bin, ...args];
}
