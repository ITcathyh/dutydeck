import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const argument = name => process.argv[process.argv.indexOf(name) + 1];
const record = argument('--record');
const agent = argument('--agent');
const sessions = new Map();
const models = ['model-default', 'project-model', 'review-model'];
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const pending = new Map();
const request = (method, params) => new Promise(resolve => { const id = randomUUID(); pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
const options = state => [
  { type: 'select', id: 'model', name: '模型', category: 'model', currentValue: state.model, options: models.map(value => ({ value, name: value })) },
  { type: 'select', id: 'reasoning_effort', name: '推理强度', category: 'thought_level', currentValue: state.reasoning, options: ['low', 'high'].map(value => ({ value, name: value })) }
];
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const { id, method, params = {}, result } = JSON.parse(line);
  if (!method && pending.has(id)) { pending.get(id)(result); pending.delete(id); return; }
  const reply = result => send({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [], agentInfo: { name: 'Group management acceptance CLI', version: '1' } });
  if (method === 'session/new' || method === 'session/load' || method === 'session/resume') {
    const sessionId = params.sessionId ?? randomUUID();
    const history = existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(item => item.sessionId === sessionId) : [];
    const state = { model: history.at(-1)?.model ?? 'model-default', reasoning: history.at(-1)?.reasoning ?? 'low', turn: history.length };
    sessions.set(sessionId, state);
    return reply({ sessionId, models: { currentModelId: state.model, availableModels: models.map(modelId => ({ modelId, name: modelId })) }, configOptions: options(state) });
  }
  const state = sessions.get(params.sessionId);
  if (method === 'session/set_model') { state.model = params.modelId; return reply({}); }
  if (method === 'session/set_config_option') {
    if (params.configId === 'model') state.model = params.value;
    if (params.configId === 'reasoning_effort') state.reasoning = params.value;
    return reply({ configOptions: options(state) });
  }
  if (method === 'session/prompt') {
    const prompt = params.prompt.map(part => part.text ?? '').join('');
    const observation = { agent, pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), sessionId: params.sessionId, model: state.model, reasoning: state.reasoning, turn: ++state.turn, prompt };
    appendFileSync(record, JSON.stringify(observation) + '\n');
    if (prompt.includes('check-risk')) {
      if (prompt.includes('hold-check-risk')) while (!existsSync(`${record}.release`)) await new Promise(resolve => setTimeout(resolve, 30));
      const permission = await request('session/request_permission', { sessionId: params.sessionId, toolCall: { title: 'Edit a file', kind: 'edit', status: 'pending', toolCallId: randomUUID(), content: [], locations: [] }, options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }, { kind: 'reject_once', name: 'Deny', optionId: 'deny' }] });
      appendFileSync(`${record}.permissions`, JSON.stringify({ prompt, optionId: permission.outcome.optionId, sessionId: params.sessionId }) + '\n');
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ACCEPTED ${agent} ${state.model} ${process.cwd()} turn=${state.turn}` } } } });
    return reply({ stopReason: 'end_turn' });
  }
  if (method === 'session/cancel') return;
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported ${method}` } });
});
