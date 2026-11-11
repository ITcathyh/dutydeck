// Synthetic Claude PID/transcript dialect. No model or network calls.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
// Inline copy of cli-paths.ts claudeProjectKey (this child imports nothing
// from src); cli-paths.test.ts asserts the two agree on every vector.
export function projectKey(path) {
  const sanitized = path.replace(/[^A-Za-z0-9]/g, '-');
  if (sanitized.length <= 200) return sanitized;
  let hash = 0;
  for (let index = 0; index < path.length; index++) hash = ((hash << 5) - hash + path.charCodeAt(index)) | 0;
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}
// Importing (to compare projectKey) must not start the fake CLI.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) run();
function run() {
  const cwd = realpathSync(process.cwd()), root = process.env.CLAUDE_CONFIG_DIR;
  const project = join(root, 'projects', process.env.FIXTURE_LEGACY_PROJECT_KEY === '1' ? cwd.replace(/[^A-Za-z0-9-]/g, '-') : projectKey(cwd));
  mkdirSync(project, { recursive: true }); mkdirSync(join(root, 'sessions'), { recursive: true });
  const raw = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const procStart = raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
  let sid = process.argv[3];
  const path = () => join(project, sid + '.jsonl');
  const append = entry => appendFileSync(path(), JSON.stringify({ sessionId: sid, cwd, timestamp: new Date().toISOString(), ...entry }) + '\n');
  const state = () => writeFileSync(join(root, 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, procStart, sessionId: sid, cwd }));
  const frame = value => {
    process.stdout.write('\x1b]7501;state=' + value + ':app=claude-code\x07');
    if (value === 'idle' || value === 'done') process.stdout.write('\x1b[2J\x1b[H────────────────────────\r\n❯\r\n────────────────────────\r\n⏵⏵ bypass permissions on (shift to cycle)');
  };
  appendFileSync(join(root, 'launches.jsonl'), JSON.stringify({ sid, args: process.argv.slice(2), pid: process.pid }) + '\n');
  if (process.env.FIXTURE_DEFER_NATIVE_STATE !== '1') state();
  frame('idle');
  if (process.env.FIXTURE_IDLE_CPU === '1') {
    const spin = () => { const until = performance.now() + 30; while (performance.now() < until) {} setImmediate(spin); };
    setImmediate(spin);
  }
  const childKind = process.env.FIXTURE_IDLE_CHILD;
  if (childKind) {
    const child = childKind === 'shell' ? spawn('/bin/sh', ['-c', 'while :; do sleep 1; done'])
      : spawn(process.execPath, ['-e', childKind === 'watcher'
        ? "require('node:fs').watch(process.cwd(),()=>{});setInterval(()=>{},1000)"
        : "process.stdin.resume();setInterval(()=>{},1000)"]);
    writeFileSync(join(root, 'child.pid'), String(child.pid));
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let buffer = '';
  process.stdin.on('data', data => {
    buffer += data.toString();
    for (;;) {
      const end = buffer.search(/[\r\n]/); if (end < 0) break;
      const text = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!text) continue;
      if (text.startsWith('/')) {
        const [command, value] = text.split(' ');
        if (command === '/compact') { append({ type: 'system', subtype: 'compact_boundary' }); continue; }
        if (command === '/clear' || command === '/branch' || command === '/resume') {
          sid = value || randomUUID(); state();
          if (command !== '/clear') append({ type: 'assistant', uuid: randomUUID(), message: { role: 'assistant', content: 'HISTORY' } });
          else writeFileSync(path(), '');
          frame('idle'); continue;
        }
      }
      let prompt; try { prompt = JSON.parse(text).prompt; } catch { continue; }
      const uuid = randomUUID(); frame('working');
      append({ type: 'user', uuid, message: { role: 'user', content: prompt } });
      if (prompt.includes('HOLD')) continue;
      const assistantId = randomUUID();
      append({ type: 'assistant', uuid: assistantId, parentUuid: uuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ANSWER:' + prompt.split('\n').at(-1) }] } });
      append({ type: 'system', subtype: 'turn_duration', uuid: randomUUID(), parentUuid: assistantId, durationMs: 1, pendingBackgroundAgentCount: 0 });
      frame('done');
    }
  });
}
