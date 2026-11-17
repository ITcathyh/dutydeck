import readline from 'node:readline';
import { appendFileSync } from 'node:fs';

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let prompt;
const permission = id => ({
  jsonrpc: '2.0', id, method: 'session/request_permission', params: {
    sessionId: prompt.sessionId,
    toolCall: { toolCallId: 'shared-tool', kind: 'execute', title: 'shared operation', status: 'pending', rawInput: { command: 'echo shared' }, content: [], locations: [] },
    options: [{ optionId: 'yes', name: 'yes', kind: 'allow_once' }, { optionId: 'no', name: 'no', kind: 'reject_once' }],
  },
});

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line), { id, method, params = {} } = message;
  if (!method) {
    appendFileSync(process.env.fixture_decisions, JSON.stringify(message) + '\n');
    if (id === 'new-permission-rpc' && prompt) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: prompt.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new permission selected' } } } });
      send({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
      prompt = undefined;
    }
    return;
  }
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [] } });
  if (method === 'session/new') return send({ jsonrpc: '2.0', id, result: { sessionId: 'stale-permission-native' } });
  if (method === 'session/load') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'session/prompt') {
    prompt = { id, sessionId: params.sessionId };
    const text = params.prompt.map(part => part.text ?? '').join('');
    if (text === 'old') send(permission('old-permission-rpc'));
    else if (text === 'new permission') send(permission('new-permission-rpc'));
    else send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new is running' } } } });
    return;
  }
  if (method === 'session/cancel' && prompt) {
    send({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
    prompt = undefined;
    return;
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
});
