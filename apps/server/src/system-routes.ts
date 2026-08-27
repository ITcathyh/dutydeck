import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverSkills } from './skill-catalog.js';

const execFileAsync = promisify(execFile);

export interface SystemRoutesOptions {
  platform?: NodeJS.Platform;
  selectDirectory?: () => Promise<string>;
  selectFile?: () => Promise<string>;
  discoverSkills?: typeof discoverSkills;
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
