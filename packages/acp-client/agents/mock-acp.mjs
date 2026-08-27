import readline from 'node:readline';
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); const { id, method, params = {} } = message;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [], agentInfo: { name: 'Dockmux Mock ACP', version: '1.0.0' } } });
  if (method === 'session/new') return send({ jsonrpc: '2.0', id, result: { sessionId: `mock-${Date.now()}` } });
  if (method === 'session/load' || method === 'session/resume') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'session/prompt') { const prompt = (params.prompt ?? []).map(part => part.text ?? '').join(''); send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Mock ACP: ${prompt}` } } } }); return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }); }
});
