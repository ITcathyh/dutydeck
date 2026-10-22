import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadavg } from 'node:os';
import { chromium } from '@playwright/test';
import ts from 'typescript';
import { createServer } from '../apps/web/node_modules/vite/dist/node/index.js';
import react from '../apps/web/node_modules/@vitejs/plugin-react/dist/index.mjs';

const baseline = process.argv[2] ?? '2abe76ec7ed84a5f16fe36e86ccf6d558066b0c4';
const oldSource = execFileSync('git', ['show', `${baseline}:apps/web/src/timeline.ts`], { encoding: 'utf8' }).replace(/^import .*$/gm, '');
const oldCode = ts.transpileModule(oldSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const webRoot = resolve('apps/web'), hostLoadAtStart = loadavg();
process.chdir(webRoot);
const vite = await createServer({ configFile: false, appType: 'custom', plugins: [react()], root: webRoot, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, logLevel: 'error' });
vite.middlewares.use(async (request, response, next) => {
  if (!request.url?.startsWith('/__projection-check')) return next();
  const html = `<!doctype html><html><head><link rel="stylesheet" href="/src/index.css"></head><body><div id="root"></div><script type="module">
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {TimelineItem} from '/src/components/TimelineItem.tsx';
    import {createTimelineProjector} from '/src/timeline.ts';
    import {createRawLogProjector} from '/src/raw-log.ts';
    import {createEventWindow,mergeReconciledEvents} from '/src/event-history.ts';
    const old={};new Function('exports',${JSON.stringify(oldCode)})(old);
    const baseline=new URL(location.href).searchParams.get('mode')==='before';
    const root=createRoot(document.getElementById('root'));let window,project,projectRaw,visible=false,raw='',output,tasks=[];
    const event=(sequence,type,data)=>({id:'fixture-'+sequence,sequence,type,timestamp:String(sequence).padStart(9,'0'),data});
    function render(){flushSync(()=>root.render(React.createElement(React.Fragment,null,
      React.createElement('button',{id:'toggle',onClick:()=>{visible=!visible;render();}},'原始日志'),
      React.createElement('div',{id:'timeline',style:{height:300,overflow:'auto'}},output.timeline.map(event=>React.createElement('div',{key:event.id,'data-fixture-event':event.id},React.createElement(TimelineItem,{event})))),
      visible?React.createElement('pre',{id:'raw',tabIndex:0,style:{width:420,height:600,overflow:'auto',whiteSpace:'pre-wrap',fontFamily:'monospace',fontSize:12,lineHeight:'20px'}},raw):null)));}
    function derive(){output=project(window.events,tasks,false,window);raw=baseline?window.events.filter(event=>event.type==='raw_terminal').map(event=>event.raw??event.data.text).join(''):projectRaw(window.events,window);render();}
    function reset(events){window=createEventWindow(events);project=(baseline?old.createTimelineProjector:createTimelineProjector)();projectRaw=createRawLogProjector();visible=false;tasks=[];derive();}
    window=undefined;
    globalThis.fixture={
      rawSeed(count){const line='中文 screen snapshot '.padEnd(127,'x')+'\\n';reset(Array.from({length:count},(_,i)=>({...event(i+1,'raw_terminal',{text:'fallback'}),raw:String(i)+line.repeat(32).slice(0,-1)})));},
      timelineSeed(count){reset([event(1000,'text',{role:'user',text:'question'}),event(1001,'text',{text:'\\n'+'\x60'.repeat(3)+'ts\\nconst stable = 1;\\n'+'\x60'.repeat(3)+'\\n'}),event(1002,'tool_call',{id:'tool',name:'Read',input:{path:'file'},status:'running'}),...Array.from({length:count},(_,i)=>event(1003+i,'text',{text:i===0?'\x60'.repeat(3)+'ts\\n':'const value'+i+' = 1;\\n'}))]);},
      append(batch){window=mergeReconciledEvents(window,batch);derive();},event,
      next(){return window.events.at(-1).sequence+1;},
      expectedRaw(){return window.events.filter(event=>event.type==='raw_terminal').map(event=>event.raw??event.data.text).join('');},
      text(){return output.timeline.map(event=>event.data.text??'').join('');},
      toggle(){document.getElementById('toggle').click();},
      ready:true
    };
    fixture.rawSeed(1);
  </script></body></html>`;
  response.setHeader('Content-Type', 'text/html');
  response.end(await vite.transformIndexHtml(request.url, html));
});
await vite.listen();
const address = vite.httpServer!.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const rawSamples: Record<string, { firstOpenMs: number; reopenMs: number; updateMs: number; characters: number }[]> = { before: [], after: [] };
const timelineSamples: Record<string, number[]> = { before: [], after: [] };
try {
  for (let sample = 0; sample < 6; sample++) for (const mode of sample % 2 ? ['after', 'before'] : ['before', 'after']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, permissions: ['clipboard-read', 'clipboard-write'] });
    page.on('pageerror', error => errors.push(error.stack ?? error.message));
    page.on('console', message => { if (message.type() === 'error' || message.text().startsWith('[fixture]')) process.stderr.write(message.text()+'\n'); });
    await page.addInitScript('globalThis.__name = value => value');
    await page.goto(`${base}/__projection-check?mode=${mode}`);
    await page.waitForFunction(() => (window as any).fixture?.ready);
    await page.evaluate(() => (window as any).fixture.rawSeed(128));
    const raw = await page.evaluate(async () => {
      const fixture = (window as any).fixture;
      const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      let start = performance.now(); fixture.toggle(); await paint();
      const firstOpenMs = performance.now() - start;
      const pre = document.getElementById('raw')!;
      if (pre.textContent !== fixture.expectedRaw()) throw new Error('first open lost complete raw log');
      const selection = document.getSelection()!; selection.selectAllChildren(pre);
      if (selection.toString() !== fixture.expectedRaw()) { const actual=selection.toString(),expected=fixture.expectedRaw();let at=0;while(at<actual.length&&actual[at]===expected[at])at++;throw new Error('raw full selection differs '+JSON.stringify({actual:actual.length,expected:expected.length,at,a:actual.slice(at,at+60),e:expected.slice(at,at+60),end:actual.slice(-20)})); }
      await navigator.clipboard.writeText(selection.toString()); selection.removeAllRanges();
      fixture.toggle(); await paint();
      start = performance.now(); fixture.toggle(); await paint();
      const reopenMs = performance.now() - start;
      start = performance.now();
      fixture.append([fixture.event(fixture.next(), 'raw_terminal', { text: 'live 中文 screen\n' })]); await paint();
      const updateMs = performance.now() - start;
      fixture.append([fixture.event(0, 'raw_terminal', { text: 'earliest screen\n' })]); await paint();
      if (document.getElementById('raw')!.textContent !== fixture.expectedRaw()) throw new Error('prepend or live raw log differs');
      return { firstOpenMs, reopenMs, updateMs, characters: fixture.expectedRaw().length };
    });
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const expectedCopy = await page.evaluate(() => (window as any).fixture.expectedRaw().slice('earliest screen\n'.length, -'live 中文 screen\n'.length));
    assert.equal(copied, expectedCopy);
    rawSamples[mode]!.push(raw);
    await page.evaluate(() => (window as any).fixture.timelineSeed(100));
    const tool = page.locator('[data-fixture-event="fixture-1002"] button').first();
    await tool.click();
    await page.evaluate(() => {
      const element = document.querySelector('[data-fixture-event="fixture-1001"] code')!;
      document.getSelection()!.selectAllChildren(element);
    });
    const text = await page.evaluate(() => document.getSelection()!.toString());
    const samples = await page.evaluate(async () => {
      const fixture = (window as any).fixture, samples: number[] = [];
      for (let index = 0; index < 8; index++) {
        const start = performance.now();
        fixture.append([fixture.event(fixture.next(), 'text', { text: 'const live'+index+' = 2;\n' })]);
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        samples.push(performance.now() - start);
      }
      fixture.append([fixture.event(fixture.next(), 'tool_result', { id: 'tool', name: 'tool call', output: 'complete result', status: 'completed' })]);
      fixture.append([fixture.event(fixture.next(), 'text', { text: '\x60'.repeat(3)+'\n' })]);
      fixture.append([fixture.event(998, 'text', { role: 'user', text: 'older question' }), fixture.event(999, 'text', { text: 'older answer' })]);
      return samples;
    });
    assert.equal(await page.evaluate(() => document.getSelection()!.toString()), text);
    assert(await page.getByText(/complete result/).count(), 'tool update collapsed expanded details');
    assert(await page.locator('code').filter({ hasText: 'const live7 = 2;' }).count(), 'streaming fenced code lost final text');
    timelineSamples[mode]!.push(...samples);
    await page.close();
  }
  assert.deepEqual(errors, []);
  const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!;
  console.log(JSON.stringify({ baseline, hostLoadAtStart, environment: 'Chromium + real React TimelineItem/MarkdownContent, raw pre same structure as App; synthetic localhost fixture', rawSamples, rawP95: Object.fromEntries(Object.entries(rawSamples).map(([mode, samples]) => [mode, { firstOpenMs: p95(samples.map(value => value.firstOpenMs)), reopenMs: p95(samples.map(value => value.reopenMs)), updateMs: p95(samples.map(value => value.updateMs)) }])), timelineP95: Object.fromEntries(Object.entries(timelineSamples).map(([mode, samples]) => [mode, p95(samples)])), completeRawSelectionAndClipboard: true, markdownSelectionAndToolDisclosureRetained: true, pageErrors: errors }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'failed', hostLoadAtStart, rawSamples, timelineSamples, pageErrors: errors }, null, 2));
  throw error;
} finally {
  await browser.close(); await vite.close();
}
