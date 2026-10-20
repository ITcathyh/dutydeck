import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import { TerminalSnapshot } from '@dutydeck/terminal-renderer';
import { PtyCliDriver } from './driver.js';

const snapshots: TerminalSnapshot[] = [];
afterEach(() => { for (const snapshot of snapshots.splice(0)) snapshot.dispose(); });
const screens = ['claude-resume-ready', 'claude-placeholder-ready'].map(name => readFileSync(new URL(`../../cli-adapters/src/fixtures/${name}/screen.txt`, import.meta.url), 'utf8'));
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
    expect(driver(snapshot, id).isIdle()).toBe(true);
  }
});

it.each([
  composer.replace('❯ ', '❯ unfinished draft'),
  '✻ Working… (esc to interrupt)\n' + composer,
  '✻ Waiting for 1 background agent to finish\n' + composer,
  'Do you want to proceed?\n❯ 1. Yes\n  2. No',
])('keeps a busy, drafted, waiting, or permission screen non-idle: %s', async screen => {
  const snapshot = new TerminalSnapshot(120, 30); snapshots.push(snapshot);
  await snapshot.writeAndFlush(screen.replaceAll('\n', '\r\n'));
  expect(driver(snapshot, 'claude-code').isIdle()).toBe(false);
});
