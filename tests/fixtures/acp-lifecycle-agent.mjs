import readline from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.env.lifecycle_directory;
const log = entry => appendFileSync(join(directory, 'calls.jsonl'), `${JSON.stringify(entry)}\n`);
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const pending = new Set();
const hostRequests = new Map();
const configOptions = [{ type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'model-a', options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }] }];
log({ method: 'spawn', pid: process.pid });
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (!method && hostRequests.has(id)) { hostRequests.get(id)(); hostRequests.delete(id); return; }
  log({ method, id });
  if (method === 'initialize') {
    if (process.env.lifecycle_initialize_fail === '1') return send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Initialization failed' } });
    return reply(id, { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [] });
  }
  if (method === 'session/new') {
    writeFileSync(join(directory, 'creating'), String(process.pid));
    while (!existsSync(join(directory, 'release'))) await new Promise(resolve => setTimeout(resolve, 10));
    return reply(id, { sessionId: 'lifecycle-native-session', configOptions });
  }
  if (method === 'session/load') return reply(id, {});
  if (method === 'session/set_config_option') return reply(id, { configOptions });
  if (method === 'session/prompt') {
    if (params.prompt.some(part => part.text?.startsWith('host terminal'))) {
      await new Promise(resolve => {
        const request = 'host-terminal'; hostRequests.set(request, resolve);
        const terminal = params.prompt.some(part => part.text === 'host terminal fallback')
          ? { command: `exec ${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'` }
          : { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };
        send({ jsonrpc: '2.0', id: request, method: 'terminal/create', params: { sessionId: params.sessionId, ...terminal } });
      });
    }
    if (params.prompt.some(part => part.text === 'wait')) { pending.add(id); return; }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: params.sessionId } } } });
    return reply(id, { stopReason: 'end_turn' });
  }
  if (method === 'session/cancel') {
    if (process.env.lifecycle_cancel_gate === '1') {
      writeFileSync(join(directory, 'cancelling'), 'waiting');
      while (!existsSync(join(directory, 'release_cancel'))) await new Promise(resolve => setTimeout(resolve, 10));
    }
    for (const request of pending) reply(request, { stopReason: 'cancelled' });
    pending.clear();
    return;
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported method' } });
});
