import readline from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 会话分析 ACP 来源采集专用 fixture：把“真正子进程环境”落到文件作为证据，
// 支持 _meta.agentSessionId 与 create/load 失败开关。不调用任何真实模型。
const dir = process.env.native_directory;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32603, message } });

appendFileSync(join(dir, 'source-spawn.jsonl'), JSON.stringify({
  pid: process.pid,
  HOME: process.env.HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  custom_home: process.env.custom_home,
  dutydeck_group_tools_url: process.env.dutydeck_group_tools_url,
  dutydeck_group_tools_token: process.env.dutydeck_group_tools_token,
  UPPER_VENDOR_TOKEN: process.env.UPPER_VENDOR_TOKEN,
  carrier_file: process.env.dutydeck_agent_env_file
}) + '\n');

readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === 'initialize') return reply(id, { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [] });
  if (method === 'session/new') {
    if (process.env.native_new_fail === '1') return fail(id, 'create refused');
    const sessionId = 'native-backend-1';
    writeFileSync(join(dir, 'source-native-id'), sessionId);
    const result = { sessionId, configOptions: [] };
    if (process.env.native_meta_id) result._meta = { agentSessionId: process.env.native_meta_id };
    return reply(id, result);
  }
  if (method === 'session/load') {
    if (process.env.native_load_fail === '1') return fail(id, 'resource not found');
    if (!existsSync(join(dir, 'source-native-id'))) return fail(id, 'resource not found');
    const result = { configOptions: [] };
    if (process.env.native_meta_id) result._meta = { agentSessionId: process.env.native_meta_id };
    return reply(id, result);
  }
  if (method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'source-ok' } } } });
    return reply(id, { stopReason: 'end_turn' });
  }
  if (id !== undefined) return fail(id, `Unsupported method ${String(method)}`);
});
