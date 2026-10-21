import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve('apps/web');
const webRequire = createRequire(resolve(webRoot, 'package.json'));
const { createServer } = webRequire('vite');
const name = `.timeline-reading-${process.pid}`;
const fixture = `import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TimelineView } from './src/components/TimelineView';
import './src/index.css';
function Fixture() {
  const [state, setState] = useState({ session: 'a', instance: 'one', visible: true, start: 0, end: 3000, older: false, height: 680 });
  window.reading = { update: next => setState(current => ({ ...current, ...next })) };
  const events = [], sections = [];
  for (let index = state.start; index < state.end; index++) {
    const user = { id: 'user-' + index, sequence: index * 3 + 1, type: 'text', timestamp: '', data: { role: 'user', text: 'Prompt ' + index + '\\n' + ('Variable height line.\\n'.repeat((index % 8 + 8) % 8)) } };
    events.push(user); sections.push({ kind: 'event', event: user, final: false });
    if (index % 2 === 0) {
      const tool = { id: 'tool-' + index, sequence: index * 3 + 2, type: 'tool_result', timestamp: '', data: { name: 'read_file', input: { path: 'file-' + index }, output: 'Expanded output ' + index, status: 'completed' } };
      events.push(tool); sections.push({ kind: 'activity', id: 'activity-' + index, groups: [{ id: 'group-' + index, label: 'Phase ' + index, events: [tool], startedAt: '' }], hasAnswer: true, taskStatus: 'completed', isLatestTurn: false });
    }
    const answer = { id: 'answer-' + index, sequence: index * 3 + 3, type: 'text', timestamp: '', data: { role: 'assistant', text: 'Answer ' + index } };
    events.push(answer); sections.push({ kind: 'event', event: answer, final: true });
  }
  return <div style={{ height: state.height, display: state.visible ? 'flex' : 'none', position: 'relative', flexDirection: 'column' }}>
    <TimelineView key={state.instance + state.session} activeSessionId={state.session} readingScopeKey={state.instance + ':' + state.session} visible={state.visible} eventsLoading={false} timeline={events} timelineSections={sections} awaitingAnswer={false} hasOngoingActivity={false} latestUserIndex={0} activeOutputLabel="Agent" hasOlder={state.older}/>
  </div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
let server: any;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await writeFile(resolve(webRoot, `${name}.tsx`), fixture);
  await writeFile(resolve(webRoot, `${name}.html`), `<div id="root"></div><script type="module" src="/${name}.tsx"></script>`);
  process.chdir(webRoot);
  server = await createServer({ root: webRoot, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => { throw error; });
  const paint = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
  const update = async (next: Record<string, unknown>) => { await page.evaluate(next => (window as any).reading.update(next), next); await paint(); };
  const snapshot = () => page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('[data-timeline-scroll]')!;
    const rect = container.getBoundingClientRect();
    const event = [...container.querySelectorAll<HTMLElement>('[data-timeline-event]')].find(event => { const box = event.getBoundingClientRect(); return box.bottom > rect.top && box.top < rect.bottom; });
    return { id: event?.dataset.timelineEvent, offset: event ? event.getBoundingClientRect().top - rect.top : 0, scrollTop: container.scrollTop, following: container.scrollHeight - container.scrollTop - container.clientHeight <= 64, turns: container.querySelectorAll('[data-timeline-turn]').length };
  });
  await page.goto(`http://127.0.0.1:${address.port}/${name}.html`);
  await page.getByText('Answer 2999', { exact: true }).waitFor();
  await paint();
  assert((await snapshot()).following, 'new task should follow latest');
  await page.locator('[data-timeline-scroll]').evaluate(element => { element.scrollTop = element.scrollHeight * .5; element.dispatchEvent(new Event('scroll')); });
  await paint();
  assert((await snapshot()).turns < 40, 'long history must stay virtualized');
  const activityId = await page.locator('[data-timeline-scroll]').evaluate(container => {
    const bounds = container.getBoundingClientRect();
    return [...container.querySelectorAll('details.reasoning')].find(element => { const rect = element.getBoundingClientRect(); return rect.top > bounds.top + 40 && rect.bottom < bounds.bottom - 40; })?.closest<HTMLElement>('[data-timeline-turn]')?.dataset.timelineTurn;
  });
  assert(activityId, 'visible activity fixture missing');
  const details = page.locator(`[data-timeline-turn="${activityId}"] details.reasoning`);
  await details.locator(':scope > summary').click();
  await details.locator('details > summary').click();
  await details.locator('[data-timeline-event] button').click();
  const output = (await details.locator('pre').textContent())!;
  // Capture a stable event after dynamic disclosure measurements settle.
  await paint();
  await page.locator('[data-timeline-scroll]').evaluate(element => element.dispatchEvent(new Event('scroll')));
  await paint();
  const before = await snapshot();
  assert(before.id && !before.following, 'fixture must be reading history');
  let maxDriftPx = 0;
  const assertAnchor = async (label: string) => {
    await paint();
    const actual = await page.locator(`[data-timeline-event="${before.id}"]`).evaluate(element => element.getBoundingClientRect().top - document.querySelector('[data-timeline-scroll]')!.getBoundingClientRect().top);
    maxDriftPx = Math.max(maxDriftPx, Math.abs(actual - before.offset));
    maxDriftPx = Math.max(maxDriftPx, Math.abs(actual - before.offset));
    assert(Math.abs(actual - before.offset) <= 2, `${label}: anchor moved ${actual - before.offset}px`);
    assert((await snapshot()).turns < 40, `${label}: virtualization lost`);
  };
  await update({ session: 'b' });
  assert((await snapshot()).following, 'independent task starts following');
  await update({ session: 'a' });
  await assertAnchor('task return');
  assert((await page.locator('pre').allTextContents()).includes(output), 'expanded tool must survive task switch');
  await update({ visible: false });
  await update({ end: 3002 });
  await update({ visible: true, height: 520 });
  await assertAnchor('hidden tab and streaming update');
  await page.getByRole('button', { name: '回到最新消息' }).waitFor();
  await update({ instance: 'two' });
  assert((await snapshot()).following, 'same task id on another instance must not inherit reading state');
  await update({ instance: 'one' });
  await assertAnchor('instance return');
  await update({ session: 'b' });
  await update({ session: 'a', start: 2600, older: true });
  await update({ start: 1000 });
  await update({ start: -100, older: false });
  await assertAnchor('history reloaded and prepended');
  await page.reload();
  await page.waitForFunction(() => !!(window as any).reading);
  await assertAnchor('browser reload with fresh row heights');
  assert((await page.locator('pre').allTextContents()).includes(output), 'disclosure must survive reload');
  await page.getByRole('button', { name: '回到最新消息' }).click();
  await paint();
  assert((await snapshot()).following, 'explicit latest restores following');
  await update({ end: 3005 });
  assert((await snapshot()).following, 'new events should follow after explicit latest');
  await update({ session: 'b' });
  await update({ session: 'a' });
  assert((await snapshot()).following, 'follow preference survives task switch');
  process.stdout.write(JSON.stringify({ status: 'passed', initialTurns: 3000, restoredAnchor: before.id, maxDriftPx, checks: ['virtualization', 'task return', 'disclosures', 'hidden tabs', 'streaming', 'instance isolation', 'prepend', 'reload', 'resume following'] }) + '\n');
} finally {
  await browser?.close();
  await server?.close();
  await Promise.all([rm(resolve(webRoot, `${name}.tsx`), { force: true }), rm(resolve(webRoot, `${name}.html`), { force: true })]);
}
