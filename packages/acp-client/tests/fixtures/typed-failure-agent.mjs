import readline from 'node:readline';
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let typed = false;
let waiting;
const providerError = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model requires a newer version of Codex."}}\n\n';
const meta = severity => ({ jetbrains: { air: { version: 1, sessionFailure: { id: 'turn-fixture:error', revision: 1, category: 'provider_error', severity, title: providerError, actions: [] } } } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === 'initialize') {
    const air = params.clientCapabilities?._meta?.jetbrains?.air;
    typed = air?.version === 1 && air.capabilities?.includes('sessionFailure');
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [] } });
  }
  if (method === 'session/new') return send({ jsonrpc: '2.0', id, result: { sessionId: 'typed-failure-native' } });
  if (method === 'session/load' || method === 'session/resume') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'session/cancel' && waiting) {
    clearInterval(waiting.timer); send({ jsonrpc: '2.0', id: waiting.id, result: { stopReason: 'cancelled' } }); waiting = undefined; return;
  }
  if (method === 'session/prompt') {
    if (!typed) return send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'fixture: typed capability missing' } });
    const prompt = params.prompt.map(part => part.text ?? '').join('');
    if (prompt === 'heartbeat') {
      const timer = setInterval(() => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'session_info_update' } } }), 200);
      waiting = { id, timer }; return;
    }
    const update = update => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update } });
    if (prompt === 'stale failure') update({ sessionUpdate: 'session_info_update', _meta: meta('error') });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: prompt === 'quote error' ? providerError : 'ordinary answer' } });
    return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', ...(prompt === 'terminal failure' ? { _meta: meta('error') } : prompt === 'warning' ? { _meta: meta('warning') } : {}) } });
  }
});
