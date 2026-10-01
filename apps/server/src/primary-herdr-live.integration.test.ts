import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { startLocalServer, type LocalServer } from './service.js';
import { runTerminalSettingsCli } from './terminal-settings-cli.js';
import { createRepositories, observeProcess, childProcessIdentity } from '@dutydeck/storage';
import { herdrControlEnvironment } from '@dutydeck/session-backends';

describe.skipIf(process.env.DUTYDECK_TEST_HERDR !== 'true')('production primary terminal setting', () => {
  it('pins new sessions, keeps ACP and existing tmux, survives daemon restart and restores real terminal viewing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dd-primary-runtime-')), db = join(cwd, 'dutydeck.db');
    const tmuxDir = join(cwd, 'tmux'); mkdirSync(tmuxDir);
    const allocated = createServer(); await new Promise<void>(resolve => allocated.listen(0, '127.0.0.1', resolve));
    const port = (allocated.address() as { port: number }).port; await new Promise<void>(resolve => allocated.close(() => resolve()));
    const url = `http://127.0.0.1:${port}`, options = { url, database: db };
    vi.stubEnv('TMUX_TMPDIR', tmuxDir);
    vi.stubEnv('HERDR_SOCKET_PATH', '/fake-default.sock'); vi.stubEnv('HERDR_PANE_ID', 'fake:p1');
    const home = join(cwd, 'agent-home'); mkdirSync(home);
    const agents = [
      { id: 'terminal-fixture', name: 'Fixture terminal', command: '/bin/sh', args: ['-c', 'exec /bin/sh'], adapterId: 'grok', protocol: 'pty-cli', cwd, env: {}, permissionMode: 'full-trust', timeout: 30, capabilities: { pause: false, resume: true }, builtin: false },
      { id: 'acp-fixture', name: 'Fixture ACP', command: process.execPath, args: [resolve('tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp', cwd, env: { HOME: home }, permissionMode: 'ask', timeout: 30, capabilities: { pause: false, resume: true }, builtin: false },
    ];
    const env = { ...process.env, DUTYDECK_PORT: String(port), DUTYDECK_HOST: '127.0.0.1', DUTYDECK_DATABASE_URL: db, DUTYDECK_DEFAULT_CWD: cwd, DUTYDECK_LARK_LISTEN: 'false', DUTYDECK_BOT_APP_ID: undefined, DUTYDECK_AGENTS_JSON: JSON.stringify(agents) };
    let server: LocalServer | undefined;
    const sessions: string[] = [], names: string[] = [];
    try {
      server = await startLocalServer({ env });
      expect(await runTerminalSettingsCli(undefined, options)).toEqual({ terminalBackend: 'tmux', scope: 'pty-cli' });
      const original = await server.runtime.start({ agentId: 'terminal-fixture' }); sessions.push(original.id);
      const oldPid = server.runtime.getDriver(original.id)!.processIds!()[0];
      const oldIdentity = childProcessIdentity(oldPid!);
      await runTerminalSettingsCli('herdr', options);
      const primary = await server.runtime.start({ agentId: 'terminal-fixture' }); sessions.push(primary.id);
      expect(primary.terminalBackend).toBe('herdr');
      const state = JSON.parse(readFileSync(join(cwd, 'terminal-sessions', readdirSync(join(cwd, 'terminal-sessions'))[0]!), 'utf8')); names.push(state.name);
      const pid = server.runtime.getDriver(primary.id)!.processIds!()[0];
      const inspection = createRepositories(db, { mode: 'management' });
      expect(JSON.parse((await inspection.config.get(`runtime_idle_terminal:${primary.id}`))!).identity.root.pid).toBe(pid);
      inspection.close();
      const nativeEnv = readFileSync(`/proc/${pid}/environ`, 'utf8');
      expect(nativeEnv).toContain(`HERDR_PANE_ID=${state.pane.pane_id}`);
      expect(nativeEnv).not.toContain('fake:p1');
      let output = '';
      const terminal = server.runtime.getDriver(primary.id)!.createTerminalStream!();
      terminal.onData(data => { output += data; }); terminal.write("printf 'PRIMARY_%s\\n' RUNTIME_IO\n");
      await expect.poll(() => output).toContain('PRIMARY_RUNTIME_IO');
      const acp = await server.runtime.start({ agentId: 'acp-fixture' }); sessions.push(acp.id);
      expect(acp.protocol).toBe('acp'); expect(acp.terminalBackend).toBeUndefined();
      await runTerminalSettingsCli('tmux', options);
      expect((await server.runtime.getSession(primary.id))!.terminalBackend).toBe('herdr');
      expect((await server.runtime.getSession(original.id))!.terminalBackend).toBe('tmux');
      const newer = await server.runtime.start({ agentId: 'terminal-fixture' }); sessions.push(newer.id);
      expect(newer.terminalBackend).toBe('tmux');
      await server.close(); server = undefined;
      server = await startLocalServer({ env });
      const restored = await server.runtime.getTerminalDriver(primary.id);
      expect(restored!.processIds!()).toEqual([pid]);
      let restoredOutput = '';
      const stream = restored!.createTerminalStream!(); stream.onData(data => { restoredOutput += data; }); stream.write("printf 'REATTACHED_%s\\n' RUNTIME_IO\n");
      await expect.poll(() => restoredOutput).toContain('REATTACHED_RUNTIME_IO');
      const restoredTmux = await server.runtime.getTerminalDriver(original.id);
      // Baseline 8d481ab retires never-prompted idle tmux panes at shutdown.
      expect(restoredTmux).toBeUndefined();
      expect(observeProcess(oldIdentity)).toBe('dead');
      expect((await server.runtime.restart(original.id)).terminalBackend).toBe('tmux');
      const freshTmux = server.runtime.getDriver(original.id)!;
      let tmuxOutput = ''; const tmuxStream = freshTmux.createTerminalStream!();
      tmuxStream.onData(data => { tmuxOutput += data; }); tmuxStream.write("printf 'TMUX_%s\\n' PINNED_RESTART\n");
      await expect.poll(() => tmuxOutput).toContain('TMUX_PINNED_RESTART');
      expect((await server.runtime.restart(primary.id)).terminalBackend).toBe('herdr');
      const replacement = server.runtime.getDriver(primary.id)!;
      expect(replacement.processIds!()[0]).not.toBe(pid);
      let replacementOutput = ''; const replacementStream = replacement.createTerminalStream!();
      replacementStream.onData(data => { replacementOutput += data; }); replacementStream.write("printf 'HERDR_%s\\n' PINNED_RESTART\n");
      await expect.poll(() => replacementOutput).toContain('HERDR_PINNED_RESTART');
      const replacementPid = replacement.processIds!()[0]!, replacementIdentity = childProcessIdentity(replacementPid);
      replacementStream.write('exit\n');
      await expect.poll(() => observeProcess(replacementIdentity)).toBe('dead');
      const retirementInspection = createRepositories(db, { mode: 'management' });
      const originalResource = retirementInspection.execution.getResources(primary.id).find(row => row.kind === 'local_only' && row.observations.at(-1)?.state !== 'gone')!;
      retirementInspection.close();
      await server.runtime.retirePtyExecution(primary.id, { decisionId: 'natural-exit-retirement', runId: (await server.runtime.getSession(primary.id))!.runId,
        resourceId: originalResource.resourceId, expectedRevision: originalResource.revision, evidenceRefs: ['real-primary-process-dead'] }, { kind: 'installation_owner', id: 'installation_owner' });
      const retiredInspection = createRepositories(db, { mode: 'management' });
      expect(retiredInspection.execution.getResources(primary.id).find(row => row.resourceId === originalResource.resourceId)!.observations.at(-1)?.state).toBe('gone');
      retiredInspection.close();
      for (const id of sessions) await server.runtime.stop(id);
      console.log(JSON.stringify({ primary_runtime: { terminal_backend: 'herdr', same_pid_after_daemon_restart: true, real_io: true, old_tmux_unchanged: true, acp_unchanged: true, persisted_setting: true, new_session_setting_only: true } }));
    } finally {
      if (server) await server.close();
      const clean = herdrControlEnvironment(process.env);
      for (const name of names) {
        try { execFileSync('herdr', ['session', 'stop', name, '--json'], { env: clean, stdio: 'pipe' }); } catch {}
        try { execFileSync('herdr', ['session', 'delete', name, '--json'], { env: clean, stdio: 'pipe' }); } catch {}
      }
      try { execFileSync('tmux', ['-S', join(tmuxDir, `tmux-${process.getuid!()}`, 'default'), 'kill-server'], { stdio: 'pipe' }); } catch {}
      vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true });
    }
  }, 60000);
});
