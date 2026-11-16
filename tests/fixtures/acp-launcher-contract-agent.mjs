import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';

const directory = process.env.lifecycle_directory;
const mode = process.env.fixture_mode;
const log = entry => appendFileSync(join(directory, 'calls.jsonl'), `${JSON.stringify(entry)}\n`);
const logProcess = (method, pid) => {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  log({ method, pid, start: fields[19], pgid: Number(fields[2]) });
};
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
logProcess('spawn', process.pid);

readline.createInterface({ input: process.stdin }).on('line', async line => {
  const { id, method, params = {} } = JSON.parse(line);
  log({ method, id, sessionId: params.sessionId });
  if (method === 'initialize') return reply(id, { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [] });
  if (method === 'session/new') return reply(id, { sessionId: 'launcher-contract-native-session' });
  if (method === 'session/load' || method === 'session/resume') return reply(id, {});
  if (method === 'session/prompt' && mode === 'cleanup-unknown') {
    log({ method: 'cleanup-ready' });
    while (!existsSync(join(directory, 'start-cleanup'))) await sleep(10);
    const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    logProcess('survivor', survivor.pid);
    survivor.unref();
    process.stderr.write('e'.repeat(256 * 1024));
    process.exit(1);
  }
  if (method === 'session/prompt' && mode === 'plain-exit') process.exit(Number(process.env.fixture_exit_code ?? 1));
  if (method === 'session/prompt' && mode === 'slow-reader') {
    log({ method: 'prompt-ready' });
    while (!existsSync(join(directory, 'start-writer'))) await sleep(10);
    const source = `
      import { appendFileSync } from 'node:fs';
      import { join } from 'node:path';
      const total = 192;
      let index = 0;
      const next = () => {
        if (index === total) {
          appendFileSync(join(process.env.lifecycle_directory, 'calls.jsonl'), JSON.stringify({ method: 'writer-finished' }) + '\\n');
          process.exit(0);
        }
        const current = index++;
        const message = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'launcher-contract-native-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'message-' + current + '-' + 'x'.repeat(1000) } } } };
        process.stdout.write(JSON.stringify(message) + '\\n', next);
      };
      next();
    `;
    const writer = spawn(process.execPath, ['--input-type=module', '-e', source], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    logProcess('writer', writer.pid);
    writer.unref();
    process.exit(7);
  }
  if (method === 'session/cancel') return;
  if (id !== undefined) reply(id, {});
});
