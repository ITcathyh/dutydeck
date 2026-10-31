// Synthetic Claude PID/transcript dialect. No model or network calls.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const cwd = realpathSync(process.cwd()), root = process.env.CLAUDE_CONFIG_DIR;
const project = join(root, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
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
