import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { RuntimeError } from '@dockmux/shared';
import { discoverSkills } from './skill-catalog.js';

const execFileAsync = promisify(execFile);

export interface SystemRoutesOptions {
  platform?: NodeJS.Platform;
  selectDirectory?: () => Promise<string>;
  selectFile?: () => Promise<string>;
  discoverSkills?: typeof discoverSkills;
  directoryRoots?: () => Promise<string[]>;
}

const withinDirectory = (path: string, root: string) => {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
};

async function listDirectories(input: unknown, additionalRoots: string[]) {
  if (input !== undefined && (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0'))) {
    throw new RuntimeError('INVALID_DIRECTORY', '请输入服务器上的绝对目录路径。', 400);
  }
  const candidates = [homedir(), process.cwd(), ...additionalRoots];
  const roots = [...new Set((await Promise.all(candidates.map(async root => {
    try { return await realpath(root); } catch { return undefined; }
  }))).filter((root): root is string => Boolean(root)))];
  const path = await realpath(input as string | undefined ?? homedir());
  const allowed = (candidate: string) => roots.some(root => withinDirectory(candidate, root));
  if (!allowed(path)) throw new RuntimeError('DIRECTORY_OUTSIDE_ROOTS', '请选择主目录或已配置工作区内的目录。', 403);
  if (!(await stat(path)).isDirectory()) throw new RuntimeError('NOT_A_DIRECTORY', '所选路径不是目录。', 400);
  await access(path, constants.R_OK | constants.X_OK);
  const entries: Array<{ name: string; path: string }> = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      const child = await realpath(join(path, entry.name));
      if (!allowed(child) || !(await stat(child)).isDirectory()) continue;
      await access(child, constants.R_OK | constants.X_OK);
      entries.push({ name: entry.name, path: child });
    } catch { /* A disappearing or unreadable child is not a selectable directory. */ }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(path);
  return { path, ...(parent !== path && allowed(parent) ? { parent } : {}), roots, host: hostname(), entries };
}

async function selectMacDirectory() {
  const { stdout } = await execFileAsync('/usr/bin/osascript', [
    '-e',
    'POSIX path of (choose folder with prompt "选择 Agent 工作区")'
  ], { timeout: 120_000 });
  return stdout.trim().replace(/\/$/, '') || '/';
}

async function selectMacFile() {
  const { stdout } = await execFileAsync('/usr/bin/osascript', [
    '-e',
    'POSIX path of (choose file with prompt "选择要引用的本地文件")'
  ], { timeout: 120_000 });
  return stdout.trim();
}

export async function registerSystemRoutes(app: FastifyInstance, options: SystemRoutesOptions = {}) {
  const platform = options.platform ?? process.platform;
  const supported = platform === 'darwin';
  app.get('/api/system/capabilities', async () => ({ platform, directoryPicker: supported, filePicker: supported }));
  app.get<{ Querystring: { path?: string } }>('/api/system/directories', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await listDirectories(request.query.path, await options.directoryRoots?.() ?? []);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new RuntimeError('DIRECTORY_NOT_FOUND', '目录不存在，请检查路径。', 404);
      if (code === 'EACCES' || code === 'EPERM') throw new RuntimeError('DIRECTORY_UNREADABLE', '服务器没有权限读取此目录。', 403);
      if (code === 'ENOTDIR') throw new RuntimeError('NOT_A_DIRECTORY', '所选路径不是目录。', 400);
      throw error;
    }
  });
  app.get<{ Querystring: { cwd?: string } }>('/api/system/skills', async request => (options.discoverSkills ?? discoverSkills)(request.query.cwd));
  app.post('/api/system/select-directory', async (_request, reply) => {
    if (!supported) return reply.code(501).send({ error: { code: 'DIRECTORY_PICKER_UNSUPPORTED', message: 'The native directory picker is currently available on macOS only' } });
    try {
      const path = await (options.selectDirectory ?? selectMacDirectory)();
      if (!path) return reply.code(409).send({ error: { code: 'DIRECTORY_SELECTION_CANCELLED', message: 'Directory selection was cancelled' } });
      return { path };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/cancel/i.test(message) || /-128/.test(message)) return reply.code(409).send({ error: { code: 'DIRECTORY_SELECTION_CANCELLED', message: 'Directory selection was cancelled' } });
      throw error;
    }
  });
  app.post('/api/system/select-file', async (_request, reply) => {
    if (!supported) return reply.code(501).send({ error: { code: 'FILE_PICKER_UNSUPPORTED', message: 'The native file picker is currently available on macOS only' } });
    try {
      const path = await (options.selectFile ?? selectMacFile)();
      if (!path) return reply.code(409).send({ error: { code: 'FILE_SELECTION_CANCELLED', message: 'File selection was cancelled' } });
      return { path };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/cancel/i.test(message) || /-128/.test(message)) return reply.code(409).send({ error: { code: 'FILE_SELECTION_CANCELLED', message: 'File selection was cancelled' } });
      throw error;
    }
  });
}
