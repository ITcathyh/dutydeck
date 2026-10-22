import { afterEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerBusinessToolCli } from './tool-cli.js';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('CLI forwards only tool input and stable call ID with session and turn capabilities', async () => {
  vi.stubEnv('dutydeck_relay_url', 'http://127.0.0.1:9000/api/relay'); vi.stubEnv('dutydeck_relay_token', 'session');
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'succeeded' }) })); vi.stubGlobal('fetch', fetcher); vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const program = new Command(); registerBusinessToolCli(program);
  await program.parseAsync(['tool', 'call', 'tickets/close', '--turn', 'attempt', '--call-id', 'stable', '--json', '{"ticket":"T1"}'], { from: 'user' });
  expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9000/api/plugin-tools/call', { method: 'POST', headers: { authorization: 'Bearer session', 'x-dutydeck-tool-turn': 'attempt', 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'tickets/close', input: { ticket: 'T1' }, callId: 'stable' }) });
});
it('CLI requires trusted session context', async () => {
  vi.stubEnv('dutydeck_relay_url', ''); vi.stubEnv('dutydeck_relay_token', '');
  const program = new Command(); registerBusinessToolCli(program);
  await expect(program.parseAsync(['tool', 'list', '--turn', 'attempt'], { from: 'user' })).rejects.toThrow('PLUGIN_TOOL_CONTEXT_REQUIRED');
});
