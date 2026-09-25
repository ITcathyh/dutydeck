import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const sessions = new Set();
const pending = new Map();
// A prompt held open for `_session/steering`; settled by a steer or session/cancel.
let steerable;
const request = (method, params) => new Promise(resolve => { const id = `mock-request-${Date.now()}`; pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });

rl.on('line', async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = message;
  if (!method && pending.has(id)) { pending.get(id)(message.result); pending.delete(id); return; }
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } }, authMethods: [], agentInfo: { name: process.env.mock_acp_agent_name ?? 'Dutydeck Mock ACP', version: '1.0.0' }, ...(process.env.mock_acp_steering === '1' ? { _meta: { steering: { supported: true } } } : {}) } });
  }
  if (method === 'session/new') {
    const sessionId = `mock-${Date.now()}`; sessions.add(sessionId);
    const configOptions = process.env.MOCK_VENDOR_TOKEN
      ? [{ type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'bridged-model', options: [{ value: 'bridged-model', name: 'Bridged Model' }] }]
      : undefined;
    return send({ jsonrpc: '2.0', id, result: { sessionId, ...(configOptions ? { configOptions } : {}) } });
  }
  if (method === 'session/load' || method === 'session/resume') {
    if (process.env.mock_acp_reject_unknown_load === '1' && !sessions.has(params.sessionId)) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Resource not found: ${params.sessionId}` } });
    sessions.add(params.sessionId); return send({ jsonrpc: '2.0', id, result: {} });
  }
  if (method === 'session/prompt') {
    const prompt = (params.prompt ?? []).map(p => p.text ?? '').join('');
    if (prompt.includes('report bridged environment')) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Bridged: ${process.env.MOCK_VENDOR_TOKEN ?? 'missing'}` } } } });
      return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    }
    if (prompt.includes('crash')) process.exit(17);
    if (prompt.includes('wait for steering')) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'waiting for steering' } } } });
      const stopReason = await new Promise(resolve => { steerable = { sessionId: params.sessionId, decline: prompt.includes('decline'), resolve }; });
      steerable = undefined;
      return send({ jsonrpc: '2.0', id, result: { stopReason } });
    }
    if (prompt.includes('permission')) {
      const decision = await request('session/request_permission', { sessionId: params.sessionId, toolCall: { title: 'Edit a file', kind: 'edit', status: 'pending', toolCallId: 'permission-tool', content: [], locations: [], ...(prompt.includes('permission guessed read') ? { title: 'Read and delete: config.json', kind: undefined } : {}), ...(prompt.includes('permission declared read') ? { title: 'Read config.json', kind: 'read' } : {}), ...(prompt.includes('permission details') ? { title: 'Run', kind: 'execute', rawInput: { description: '运行项目测试', command: 'pnpm test --token=synthetic-cli-secret && echo synthetic-env-secret', cwd: '/work/project', path: '/work/project/config.ts', content: 'PRIVATE FILE CONTENT', nested: { arbitrary: 'DO NOT DISPLAY' } } } : {}) }, options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }, { kind: 'reject_once', name: 'Deny', optionId: 'deny' }] });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Permission: ${decision.outcome.outcome} ${JSON.stringify(decision.outcome)}` } } } });
      return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    }
    if (prompt.includes('active longer than timeout')) {
      for (let index = 1; index <= 3; index++) {
        await new Promise(resolve => setTimeout(resolve, 1_100));
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `heartbeat ${index}` } } } });
      }
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'long task completed' } } } });
      return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    }
    const toolCallId = 'mock-tool-1';
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Considering the request' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId, title: 'Inspect workspace', kind: 'read', status: 'in_progress', rawInput: { path: '.' }, content: [], locations: [] } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { files: [] }, content: [] } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Mock reply: ${prompt}` } } } });
    return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
  }
  if (method === '_session/steering') {
    const text = (params.prompt ?? []).map(p => p.text ?? '').join('');
    // An agent that takes the request and never answers it, or drops the connection instead.
    if (text.includes('never answer')) return send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'steering unanswered' } } } });
    if (text.includes('drop connection')) process.exit(18);
    if (!steerable || steerable.sessionId !== params.sessionId || steerable.decline) return send({ jsonrpc: '2.0', id, result: params._meta?.steering?.idleBehavior === 'promptRequired' ? { outcome: 'promptRequired', reason: 'noRunningTurn' } : { outcome: 'startedNewTurn' } });
    send({ jsonrpc: '2.0', id, result: { outcome: 'injected' } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Steered: ${text}` } } } });
    return steerable.resolve('end_turn');
  }
  if (method === 'session/cancel') { steerable?.resolve('cancelled'); return; }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method ${method}` } });
});
