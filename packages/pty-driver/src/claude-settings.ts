import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const claudeAdapters = new Set(['claude-code', 'seed', 'relay', 'genius']);

function settingsArgs(args: string[]): { rest: string[]; value?: string } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { rest.push(...args.slice(i)); break; }
    if (arg === '--settings') value = args[++i] ?? '';
    else if (arg.startsWith('--settings=')) value = arg.slice('--settings='.length);
    else rest.push(arg);
  }
  return { rest, value };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readSettings(value: string, cwd: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value.trimStart().startsWith('{') ? value : readFileSync(resolve(cwd, value), 'utf8'));
    if (!object(parsed) || (parsed.permissions !== undefined && !object(parsed.permissions))) throw new Error();
    return parsed;
  } catch {
    // JSON parser errors can include the settings contents, including credentials.
    throw new Error('Invalid Claude --settings: expected a readable JSON object with object permissions');
  }
}

/** The session directory survives daemon detach so an adopted pane keeps its settings. */
export class ClaudeSettings {
  private readonly directory: string;
  private readonly files = new Set<string>();

  constructor(private readonly adapterId: string, sessionId: string) {
    const key = createHash('sha256').update(sessionId).digest('hex');
    this.directory = join(tmpdir(), `dutydeck-claude-settings-${process.getuid?.() ?? 'user'}-${key}`);
    if (claudeAdapters.has(adapterId)) {
      try {
        this.assertPrivateDirectory();
        for (const file of readdirSync(this.directory)) this.files.add(join(this.directory, file));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  args(userArgs: string[], generatedArgs: string[], cwd: string): string[] {
    if (!claudeAdapters.has(this.adapterId)) return [...userArgs, ...generatedArgs];
    const user = settingsArgs(userArgs);
    const generated = settingsArgs(generatedArgs);
    if (user.value === undefined || generated.value === undefined) return [...userArgs, ...generatedArgs];
    const original = readSettings(user.value, cwd);
    const overrides = readSettings(generated.value, cwd);
    const merged = { ...original, ...overrides,
      ...((original.permissions || overrides.permissions) ? { permissions: { ...original.permissions as object, ...overrides.permissions as object } } : {}),
      ...(object(overrides.hooks) ? { hooks: {
        ...original.hooks as object,
        ...Object.fromEntries(Object.entries(overrides.hooks).map(([event, hooks]) => {
          const existing = object(original.hooks) ? original.hooks[event] : undefined;
          return [event, [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(hooks) ? hooks : [])]];
        })),
      } } : {}),
    };
    try { mkdirSync(this.directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    this.assertPrivateDirectory();
    const path = join(this.directory, `${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify(merged), { mode: 0o600, flag: 'wx' });
    this.files.add(path);
    return [...user.rest, ...generated.rest, '--settings', path];
  }

  cleanup(): void {
    if (!claudeAdapters.has(this.adapterId)) return;
    // An old process can exit after a replacement has spawned. Only remove
    // files this driver created or adopted, never the replacement's settings.
    for (const path of this.files) rmSync(path, { force: true });
    this.files.clear();
    try { rmdirSync(this.directory); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }

  private assertPrivateDirectory(): void {
    const directory = lstatSync(this.directory);
    if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700 || (process.getuid && directory.uid !== process.getuid())) {
      throw new Error('Claude settings directory must be private and owned by the current user');
    }
  }
}
