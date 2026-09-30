// 仿 claude-agent-acp 0.66.0 的长工具：发出 tool_call 之后，每 300ms 一条带
// `_meta.claudeCode.toolResponse.elapsedTimeSeconds` 的 tool_call_update 心跳（acp-agent.js 的 tool_progress 分支），
// 直到收到 session/cancel。提示词含 busy 时工具拉起一个占满 CPU 的子进程，否则工具只是在等。
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const rl = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let running;
const stopTool = () => {
  if (!running) return;
  const { id, timer, child } = running;
  running = undefined;
  clearInterval(timer);
  child?.kill('SIGKILL');
  send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
};
process.on('exit', () => running?.child?.kill('SIGKILL'));

rl.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [], agentInfo: { name: 'Dutydeck Busy Tool Fixture', version: '1.0.0' } } });
  }
  if (method === 'session/new') return send({ jsonrpc: '2.0', id, result: { sessionId: `busy-${Date.now()}` } });
  if (method === 'session/load' || method === 'session/resume') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'session/prompt') {
    const prompt = (params.prompt ?? []).map(part => part.text ?? '').join('');
    const toolCallId = 'long-tool';
    const update = value => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: value } });
    update({ sessionUpdate: 'tool_call', toolCallId, title: 'Run tests', kind: 'execute', status: 'in_progress', rawInput: { command: 'pnpm test' }, content: [], locations: [] });
    const startedAt = Date.now();
    // 子进程自带 20 秒上限：测试进程异常退出时也不会留下一直空转的进程。
    const child = prompt.includes('busy')
      ? spawn(process.execPath, ['-e', 'const end = Date.now() + 20000; while (Date.now() < end) {}'], { stdio: 'ignore' })
      : undefined;
    const timer = setInterval(() => update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress',
      _meta: { claudeCode: { toolName: 'Bash', toolResponse: { elapsedTimeSeconds: Math.floor((Date.now() - startedAt) / 1000) } } } }), 300);
    running = { id, timer, child };
    return;
  }
  if (method === 'session/cancel') return stopTool();
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method ${method}` } });
});
