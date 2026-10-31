import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage';
import { dutydeckPtySessionName } from '@dutydeck/pty-driver';
import type { Session } from '@dutydeck/shared';
import { createPtyRetirementControl } from './pty-recovery.js';

let root: string, socket: string, saved: string | undefined;
const servers: ReturnType<typeof childProcessIdentity>[] = [];
const probe = { identify: childProcessIdentity, observe: observeProcess };
const session = (): Session => ({ id: 'ses_review_retirement', runId: 'run', agentId: 'fixture', cwd: root,
  state: 'idle', protocol: 'pty-cli', terminalBackend: 'tmux', createdAt: '', updatedAt: '' });
const tmux = (...args: string[]) => execFileSync('/usr/bin/tmux', ['-S', socket, ...args], {
  encoding: 'utf8', env: { ...process.env, TMUX: '', TMUX_TMPDIR: '' }, stdio: ['ignore', 'pipe', 'pipe']
}).trim();
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dd-pty-retirement-')));
  socket = join(root, `tmux-${process.getuid!()}`, 'default'); mkdirSync(dirname(socket));
  saved = process.env.TMUX_TMPDIR; process.env.TMUX_TMPDIR = root;
});
afterEach(() => {
  try { tmux('kill-server'); } catch {}
  for (const server of servers.splice(0)) if (observeProcess(server) === 'alive') process.kill(server.pid, 'SIGTERM');
  if (saved === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = saved;
  rmSync(root, { recursive: true, force: true });
});
it.skipIf(process.platform !== 'linux')('keeps an absent socket proof scoped and rejects it when the service is still bound', async () => {
  const control = createPtyRetirementControl(probe), s = session();
  const absent = await control.captureAbsence!(s);
  expect(absent).toMatchObject({ absent: true, scope: { socketPath: socket, ownerId: `dutydeck:${s.id}`, hostname: hostname() } });
  expect(await control.verify(s, absent)).toBe(true);
  tmux('new-session', '-d', '-s', 'other', '/bin/sh');
  servers.push(childProcessIdentity(Number(tmux('display-message', '-p', '-t', 'other', '#{pid}'))));
  rmSync(socket);
  await expect(control.captureAbsence!(s)).rejects.toThrow('SOCKET_STILL_BOUND');
  expect(await control.verify(s, absent)).toBe(false);
});
it('does not retire a renamed terminal through the server-side control', async () => {
  const control = createPtyRetirementControl(probe), s = session();
  tmux('new-session', '-d', '-s', 'other', '/bin/sh');
  const absent = await control.captureAbsence!(s);
  const name = dutydeckPtySessionName(s.id);
  tmux('new-session', '-d', '-s', name, '/bin/sh');
  tmux('set-option', '-t', name, '@dutydeck_owner_id', `dutydeck:${s.id}`);
  tmux('rename-session', '-t', name, 'renamed');
  expect(await control.captureAbsence!(s)).toBeUndefined();
  expect(await control.verify(s, absent)).toBe(false);
});
