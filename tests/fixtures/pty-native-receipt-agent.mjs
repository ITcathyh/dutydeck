import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

// Transport is a real persistent PTY. Native user/assistant records have the
// Claude shape; gates model delayed persistence and completion independently.
const root = process.env.receipt_fixture_root;
const transcript = process.env.receipt_fixture_transcript;
mkdirSync(dirname(transcript), { recursive: true });
writeFileSync(join(root, 'ready'), String(process.pid));
process.stdout.write('FIXTURE_READY\r\n');
const waitFor = path => new Promise(resolve => {
  const timer = setInterval(() => { if (existsSync(path)) { clearInterval(timer); resolve(); } }, 20);
});
const append = entry => appendFileSync(transcript, JSON.stringify(entry) + '\n');
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on('line', line => {
  let prompt;
  try { prompt = JSON.parse(line); } catch { return; }
  if (typeof prompt !== 'string') return;
  appendFileSync(join(root, 'submissions.jsonl'), JSON.stringify({ acceptedByTransport: true }) + '\n');
  queue = queue.then(async () => {
    process.stdout.write('\x1b[2J\x1b[HFIXTURE_WORKING\r\n');
    await waitFor(join(root, 'receipt'));
    append({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
    await waitFor(join(root, 'final'));
    append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture final answer' }], stop_reason: 'end_turn' } });
    process.stdout.write('\x1b[2J\x1b[HFIXTURE_DONE\r\n');
  });
});
