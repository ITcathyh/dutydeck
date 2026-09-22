import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LegacyRetirementCandidate } from '@dutydeck/shared';
import { dutydeckPtySessionName } from '@dutydeck/pty-driver';
import { createLegacyRetirementVerifier, verifyLegacyRetirementCandidate } from './legacy-session-retirement.js';

const sockets: string[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) {
    try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
  }
});

const uid = process.getuid!();
const options = (overrides: Record<string, unknown> = {}) => ({ hostname: hostname(), uid, ...overrides });
const candidate = (overrides: Partial<LegacyRetirementCandidate> = {}): LegacyRetirementCandidate => ({
  sessionId: 'ses_private', runId: 'run_private', databaseEntity: '1:2', snapshotDigest: 'a'.repeat(64),
  agentId: 'ccflash', cwd: '/workspace', protocol: 'pty-cli', state: 'completed', blockers: [], ...overrides
});
const socket = () => {
  const directory = mkdtempSync(join(tmpdir(), 'dutydeck-tmux-retire-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'socket'); sockets.push(path); return path;
};
const runTmux = (socketPath: string, args: string[]) => execFileSync('tmux', ['-S', socketPath, ...args], { encoding: 'utf8' });

describe('legacy retirement resource verification', () => {
  it('requires the operator-supplied host and uid to match the maintenance process', async () => {
    await expect(verifyLegacyRetirementCandidate(candidate(), options({ hostname: `${hostname()}-other` }))).resolves.toMatchObject({ status: 'blocked', code: 'LEGACY_RETIREMENT_HOST_MISMATCH' });
    await expect(verifyLegacyRetirementCandidate(candidate(), options({ uid: uid + 1 }))).resolves.toMatchObject({ status: 'blocked', code: 'LEGACY_RETIREMENT_UID_MISMATCH' });
  });

  it('binds an existing archive time into the receipt', async () => {
    const socketPath = socket();
    runTmux(socketPath, ['new-session', '-d', '-s', 'unrelated', 'sleep 60']);
    const archivedAt = '2026-08-20T02:00:00.000Z';
    await expect(verifyLegacyRetirementCandidate(candidate({ archivedAt }), options({ tmuxSocket: socketPath })))
      .resolves.toMatchObject({ status: 'ready', receipt: { archivedAt, verifiedAt: expect.any(String) } });
    expect(() => runTmux(socketPath, ['has-session', '-t', '=unrelated'])).not.toThrow();
  });

  it('does not stop the exact same tmux name when its owner differs', async () => {
    const socketPath = socket();
    const target = dutydeckPtySessionName('ses_private');
    runTmux(socketPath, ['new-session', '-d', '-s', target, 'sleep 60']);
    runTmux(socketPath, ['set-option', '-t', target, '@dutydeck_owner_id', 'dutydeck:someone-else']);
    await expect(verifyLegacyRetirementCandidate(candidate(), options({ tmuxSocket: socketPath }))).resolves.toMatchObject({ status: 'blocked', code: 'LEGACY_TMUX_OWNER_MISMATCH' });
    expect(() => runTmux(socketPath, ['has-session', '-t', `=${target}`])).not.toThrow();
  });

  it('stops only an owned stable target and waits for its pane descendants to exit', async () => {
    const socketPath = socket();
    const target = dutydeckPtySessionName('ses_private');
    runTmux(socketPath, ['new-session', '-d', '-s', 'foreign', 'sleep 60']);
    runTmux(socketPath, ['new-session', '-d', '-s', target, 'sh', '-c', 'sleep 60 & wait']);
    runTmux(socketPath, ['set-option', '-t', target, '@dutydeck_owner_id', 'dutydeck:ses_private']);
    const result = await verifyLegacyRetirementCandidate(candidate(), options({ tmuxSocket: socketPath }));
    expect(result).toMatchObject({ status: 'ready', receipt: { evidence: { kind: 'pty_tmux_absent', outcome: 'stopped_owned', owner: 'dutydeck:ses_private' } } });
    if (result.status !== 'ready' || result.receipt.evidence.kind !== 'pty_tmux_absent') throw new Error('expected PTY receipt');
    expect(result.receipt.evidence.targetId).toMatch(/^\$\d+$/);
    expect(result.receipt.evidence.paneProcesses.length).toBeGreaterThanOrEqual(2);
    expect(() => runTmux(socketPath, ['has-session', '-t', `=${target}`])).toThrow();
    expect(() => runTmux(socketPath, ['has-session', '-t', '=foreign'])).not.toThrow();
  });

  it('keeps the bound socket scope after stopping its last owned session', async () => {
    const socketPath = socket();
    const target = dutydeckPtySessionName('ses_private');
    runTmux(socketPath, ['new-session', '-d', '-s', target, 'sleep 60']);
    runTmux(socketPath, ['set-option', '-t', target, '@dutydeck_owner_id', 'dutydeck:ses_private']);
    const verify = createLegacyRetirementVerifier(options({ tmuxSocket: socketPath }));
    await expect(verify(candidate())).resolves.toMatchObject({ status: 'ready' });
    await expect(verify(candidate({ sessionId: 'ses_missing', runId: 'run_missing' }))).resolves.toMatchObject({
      status: 'ready', receipt: { evidence: { outcome: 'already_missing' } }
    });
  });

  it('keeps the batch socket bound after an absent first target and rejects a replacement server', async () => {
    const socketPath = socket();
    runTmux(socketPath, ['new-session', '-d', '-s', 'first_unrelated', 'sleep 60']);
    const verify = createLegacyRetirementVerifier(options({ tmuxSocket: socketPath }));
    await expect(verify(candidate())).resolves.toMatchObject({ status: 'ready', receipt: { evidence: { outcome: 'already_missing' } } });
    const movedSocket = `${socketPath}-original`;
    renameSync(socketPath, movedSocket); sockets.push(movedSocket);
    const target = dutydeckPtySessionName('ses_private');
    runTmux(socketPath, ['new-session', '-d', '-s', target, 'sleep 60']);
    runTmux(socketPath, ['set-option', '-t', target, '@dutydeck_owner_id', 'dutydeck:ses_private']);
    await expect(verify(candidate())).resolves.toMatchObject({ status: 'blocked', code: 'LEGACY_TMUX_SOCKET_CHANGED' });
    expect(() => runTmux(socketPath, ['has-session', '-t', `=${target}`])).not.toThrow();
  });

  it('classifies an invalid socket path as blocked without touching another server', async () => {
    const liveSocket = socket();
    const target = dutydeckPtySessionName('ses_private');
    runTmux(liveSocket, ['new-session', '-d', '-s', target, 'sleep 60']);
    runTmux(liveSocket, ['set-option', '-t', target, '@dutydeck_owner_id', 'dutydeck:ses_private']);
    const badPath = join(mkdtempSync(join(tmpdir(), 'dutydeck-bad-socket-')), 'regular');
    writeFileSync(badPath, 'not a socket');
    await expect(verifyLegacyRetirementCandidate(candidate(), options({ tmuxSocket: badPath }))).resolves.toMatchObject({ status: 'blocked', code: 'LEGACY_RETIREMENT_PATH_TYPE_MISMATCH' });
    expect(() => runTmux(liveSocket, ['has-session', '-t', `=${target}`])).not.toThrow();
  });

  it('keeps an initially absent socket blocked because its deployment scope cannot be bound', async () => {
    const absent = join(mkdtempSync(join(tmpdir(), 'dutydeck-absent-socket-')), 'socket');
    await expect(verifyLegacyRetirementCandidate(candidate(), options({ tmuxSocket: absent }))).resolves.toMatchObject({
      status: 'blocked', code: 'LEGACY_RETIREMENT_PATH_UNAVAILABLE'
    });
  });

  it('keeps a permission-denied socket probe blocked without killing the owned target', async () => {
    const socketPath = socket();
    const target = dutydeckPtySessionName('ses_private');
    runTmux(socketPath, ['new-session', '-d', '-s', target, 'sleep 60']);
    runTmux(socketPath, ['set-option', '-t', target, '@dutydeck_owner_id', 'dutydeck:ses_private']);
    chmodSync(socketPath, 0o000);
    const result = await verifyLegacyRetirementCandidate(candidate(), options({ tmuxSocket: socketPath }));
    chmodSync(socketPath, 0o600);
    expect(result).toMatchObject({ status: 'blocked', code: 'LEGACY_TMUX_PROBE_UNKNOWN' });
    expect(() => runTmux(socketPath, ['has-session', '-t', `=${target}`])).not.toThrow();
  });

  it('accepts only matching ACP metadata with a currently absent recorded pid', async () => {
    const acpxDirectory = mkdtempSync(join(tmpdir(), 'dutydeck-acpx-retire-'));
    chmodSync(acpxDirectory, 0o700);
    const sessions = join(acpxDirectory, 'sessions'); mkdirSync(sessions, { mode: 0o700 });
    const acp = candidate({ protocol: 'acp', agentId: 'codex', cwd: '/old/workspace' });
    const recordPath = join(sessions, `${encodeURIComponent(acp.sessionId)}.json`);
    let absentPid = Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim());
    while (existsSync(`/proc/${absentPid}`)) absentPid -= 1;
    writeFileSync(recordPath, JSON.stringify({ schema: 'acpx.session.v1', acpx_record_id: acp.sessionId, cwd: acp.cwd, pid: absentPid, agent_started_at: '2026-08-30T10:57:33.711Z', closed: true, messages: ['must not appear'] }), { mode: 0o600 });
    const result = await verifyLegacyRetirementCandidate(acp, options({ acpxDirectory }));
    expect(result).toMatchObject({ status: 'ready', receipt: { evidence: { kind: 'acp_recorded_agent_pid_absent', pid: absentPid } } });
    expect(JSON.stringify(result)).not.toContain('must not appear');

    writeFileSync(recordPath, JSON.stringify({ schema: 'acpx.session.v1', acpx_record_id: acp.sessionId, cwd: acp.cwd, closed: true }), { mode: 0o600 });
    await expect(verifyLegacyRetirementCandidate(acp, options({ acpxDirectory }))).resolves.toMatchObject({ status: 'blocked', code: 'LEGACY_ACP_PROCESS_METADATA_INCOMPLETE' });
    writeFileSync(recordPath, '{invalid', { mode: 0o600 });
    await expect(verifyLegacyRetirementCandidate(acp, options({ acpxDirectory }))).resolves.toMatchObject({ status: 'blocked', code: 'LEGACY_ACP_RECORD_INVALID' });
  });

  it('keeps a live ACP recorded pid blocked even when the record says closed', async () => {
    const acpxDirectory = mkdtempSync(join(tmpdir(), 'dutydeck-acpx-live-'));
    chmodSync(acpxDirectory, 0o700); mkdirSync(join(acpxDirectory, 'sessions'), { mode: 0o700 });
    const acp = candidate({ protocol: 'acp', cwd: '/old/workspace' });
    writeFileSync(join(acpxDirectory, 'sessions', `${encodeURIComponent(acp.sessionId)}.json`), JSON.stringify({
      schema: 'acpx.session.v1', acpx_record_id: acp.sessionId, cwd: acp.cwd, pid: process.pid,
      agent_started_at: '2026-08-30T10:57:33.711Z', closed: true
    }), { mode: 0o600 });
    await expect(verifyLegacyRetirementCandidate(acp, options({ acpxDirectory }))).resolves.toMatchObject({ status: 'blocked', code: 'LEGACY_ACP_RECORDED_PROCESS_LIVE' });
  });
});
