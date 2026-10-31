import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write('HappyClaw acceptance ACP 1.0\n');
  process.exit(0);
}
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const sessions = new Map();
const report = '<script>window.happyclawPreviewExecuted=true</script><svg onload="window.happyclawPreviewExecuted=true"></svg>\nHAPPYCLAW_SNAPSHOT_ORIGINAL\n';
const options = model => [{ type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: model, options: [{ value: 'fixture-before', name: 'Before' }, { value: 'fixture-after', name: 'After' }] }];
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  const result = value => send({ jsonrpc: '2.0', id, result: value });
  if (method === 'initialize') return result({ protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } }, authMethods: [], agentInfo: { name: 'HappyClaw acceptance ACP', version: '1.0' } });
  if (method === 'session/new') {
    const sessionId = `acceptance-${sessions.size + 1}`;
    sessions.set(sessionId, params.cwd);
    return result({ sessionId, configOptions: options('fixture-before') });
  }
  if (method === 'session/load') { sessions.set(params.sessionId, params.cwd); return result({ configOptions: options('fixture-before') }); }
  if (method === 'session/set_config_option') return result({ configOptions: options(params.value) });
  if (method === 'session/prompt') {
    const prompt = (params.prompt ?? []).map(part => part.text ?? '').join('');
    appendFileSync(process.env.happyclaw_prompt_log, JSON.stringify({ sessionId: params.sessionId, prompt }) + '\n');
    const update = value => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: value } });
    if (prompt.includes('HAPPYCLAW_CAPTURE_REPORT')) {
      const path = join(sessions.get(params.sessionId), 'report.html');
      writeFileSync(path, report);
      update({ sessionUpdate: 'tool_call', toolCallId: 'report', title: 'Create local report', kind: 'execute', status: 'in_progress', content: [] });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'report', status: 'completed', content: [{ type: 'content', content: { type: 'resource_link', uri: pathToFileURL(path).href, name: 'report.html', mimeType: 'text/html' } }] });
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Fixture completed: ${prompt.split('\n').at(-1)}` } });
    return result({ stopReason: 'end_turn' });
  }
  if (method === 'session/cancel') return;
  if (id !== undefined) result({});
});
