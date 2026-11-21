import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import { TerminalSnapshot } from '@dutydeck/terminal-renderer';
import { IdleDetector } from './idle-detector.js';
import { PtyCliDriver } from './driver.js';

const snapshots: TerminalSnapshot[] = [];
afterEach(() => { for (const snapshot of snapshots.splice(0)) snapshot.dispose(); });
const screens = ['claude-resume-ready', 'claude-placeholder-ready', 'claude-statusline-ready'].map(name => readFileSync(new URL(`../../cli-adapters/src/fixtures/${name}/screen.txt`, import.meta.url), 'utf8'));
const composer = '─'.repeat(80) + '\n❯ \n' + '─'.repeat(80) + '\n? for shortcuts';
screens.push(composer, composer.replace('? for shortcuts', '⏸ manual mode on'), composer.replace('? for shortcuts', '⏵⏵ auto mode on (shift+tab to cycle)'));

function driver(snapshot: TerminalSnapshot, id: string): PtyCliDriver {
  return Object.assign(Object.create(PtyCliDriver.prototype), { snapshot, adapter: createCliAdapter(id), stopped: false, turnActive: false,
    humanWaits: new Set(), hookPermissions: new Map() });
}

it.each(['claude-code', 'seed', 'relay'])('%s recognizes recorded and supported idle composers after actual terminal parsing', async id => {
  for (const screen of screens) {
    const snapshot = new TerminalSnapshot(120, 30); snapshots.push(snapshot);
    await snapshot.writeAndFlush(screen.replaceAll('\n', '\r\n'));
    expect(snapshot.viewportText()).not.toContain('─');
    const pty = driver(snapshot, id);
    expect(pty.quiescence().state).toBe('idle');
    expect(pty.isIdle()).toBe(true);
  }
});

it.each([
  [composer.replace('❯ ', '❯ unfinished draft'), 'unknown', 'composer_not_recognized'],
  ['✻ Working… (esc to interrupt)\n' + composer, 'busy', 'status_activity'],
  ['✻ Waiting for 1 background agent to finish\n' + composer, 'busy', 'background_wait'],
  [composer + '\nesc to interrupt', 'busy', 'screen_busy'],
  ['Do you want to proceed?\n❯ 1. Yes\n  2. No', 'busy', 'human_prompt'],
])('keeps a busy, drafted, waiting, or permission screen non-idle: %s', async (screen, state, evidence) => {
  const snapshot = new TerminalSnapshot(120, 30); snapshots.push(snapshot);
  await snapshot.writeAndFlush(screen.replaceAll('\n', '\r\n'));
  const pty = driver(snapshot, 'claude-code');
  expect(pty.quiescence()).toEqual({ state, evidence });
  expect(pty.isIdle()).toBe(false);
});

it.each([
  ['turn_active', { turnActive: true }],
  ['submission_active', { activeSubmission: {} }],
  ['maintenance_active', { maintenanceActive: {} }],
  ['background_work', { transcript: { pendingBackgroundWork: () => 1 } }],
] as const)('reports %s even with an empty composer', async (evidence, state) => {
  const snapshot = new TerminalSnapshot(120, 30); snapshots.push(snapshot);
  await snapshot.writeAndFlush(composer.replaceAll('\n', '\r\n'));
  const pty = driver(snapshot, 'claude-code');
  Object.assign(pty, state);
  expect(pty.quiescence()).toEqual({ state: 'busy', evidence });
  expect(pty.isIdle()).toBe(false);
});

it('distinguishes no screen from a human prompt on an adapter without an idle matcher', async () => {
  const snapshot = new TerminalSnapshot(120, 30); snapshots.push(snapshot);
  const pty = driver(snapshot, 'codex');
  await snapshot.writeAndFlush('Waiting for your answer');
  expect(pty.quiescence()).toEqual({ state: 'busy', evidence: 'human_prompt' });
  Object.assign(pty, { snapshot: undefined });
  expect(pty.quiescence()).toEqual({ state: 'unknown', evidence: 'no_snapshot' });
});

it.each([
  ['codex', '• Working (2s • esc to interrupt)'],
  ['pi', 'Working...'],
])('recognizes the current %s activity marker after a turn loses its receipt', async (id, status) => {
  const snapshot = new TerminalSnapshot(120, 30); snapshots.push(snapshot);
  await snapshot.writeAndFlush(status);
  const pty = driver(snapshot, id);
  expect(pty.quiescence().state).toBe('busy');
  await snapshot.writeAndFlush('\x1b[2J\x1b[H❯ Explain ' + status);
  expect(pty.quiescence().state).toBe('unknown');
});

it.each(['static queue', 'program status', 'busy transition'] as const)('keeps %s busy until its explicit clear', async source => {
  const snapshot = new TerminalSnapshot(120, 30); snapshots.push(snapshot);
  const id = source === 'program status' ? 'claude-code' : 'traex';
  const detector = new IdleDetector(createCliAdapter(id));
  const pty = driver(snapshot, id);
  Object.assign(pty, { idleDetector: detector });
  try {
    if (source === 'static queue') detector.feed('Queued for capacity');
    else if (source === 'busy transition') {
      detector.fireIdle();
      detector.feed('⠋ Thinking…');
    } else {
      detector.enableProgramStatus(() => {});
      detector.observeProgramStatus({ app: 'claude-code', state: 'working' });
    }
    expect(pty.quiescence().state).toBe('busy');
    if (source === 'static queue') detector.feed('❯ ');
    else if (source === 'busy transition') detector.fireIdle();
    else detector.observeProgramStatus({ app: 'claude-code', state: 'done' });
    expect(pty.quiescence().state).toBe('unknown');
  } finally { detector.dispose(); }
});
