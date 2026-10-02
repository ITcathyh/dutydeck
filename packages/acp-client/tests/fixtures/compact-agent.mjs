import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'codex';
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (sessionId, text) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
let held;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  const result = value => send({ jsonrpc: '2.0', id, result: value });
  if (method === 'initialize') return result({ protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [] });
  if (['session/new', 'session/load', 'session/resume'].includes(method)) {
    const sessionId = params.sessionId ?? 'native-compact-session';
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: mode === 'unsupported' ? [] : [{ name: 'compact', description: 'Native context compaction', input: null }] } } });
    return result(method === 'session/new' ? { sessionId } : {});
  }
  if (method === 'session/cancel') {
    if (held) { send({ jsonrpc: '2.0', id: held.id, result: { stopReason: 'cancelled' } }); held = undefined; }
    return;
  }
  if (method !== 'session/prompt') return;
  const prompt = params.prompt.map(part => part.text ?? '').join('');
  if (process.env.compact_test_log) appendFileSync(process.env.compact_test_log, `${prompt}\n`);
  if (mode === 'withdrawn') send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } });
  if (prompt !== '/compact') { update(params.sessionId, `Reply: ${prompt}`); return result({ stopReason: 'end_turn', ...(mode === 'usage' ? { usage: { inputTokens: 20, outputTokens: 2 } } : {}) }); }
  if (mode === 'held') { held = { id }; return; }
  if (mode === 'claude' || mode === 'failed') {
    update(params.sessionId, 'Compacting...');
    update(params.sessionId, mode === 'failed' ? '\n\nCompacting failed: test failure' : '\n\nCompacting completed.');
  }
  return result({ stopReason: mode === 'cancelled' ? 'cancelled' : 'end_turn', ...(mode === 'usage' ? { usage: { inputTokens: 100, outputTokens: 10 } } : {}) });
});
