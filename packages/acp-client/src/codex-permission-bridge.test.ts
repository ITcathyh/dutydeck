import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.each(['ask', 'approve-reads', 'deny-all', 'full-trust'])('overrides native creation, restoration and every turn policy in %s', async mode => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-codex-wire-policy-'));
  const executable = join(cwd, 'native-codex');
  const output = join(cwd, 'wire.jsonl');
  await writeFile(executable, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';process.stdin.on('data',chunk=>appendFileSync(process.env.wire_output,chunk));\n`);
  await chmod(executable, 0o755);
  const bridge = spawn(process.execPath, [resolve('packages/acp-client/agents/codex-permission-bridge.mjs'), 'app-server'], {
    env: { ...process.env, dutydeck_codex_executable: executable, dutydeck_codex_permission_mode: mode, wire_output: output }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = ''; bridge.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const messages = ['initialize', 'thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'turn/start'].map((method, id) => ({ id, method,
      params: { text: '权限边界', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } } }));
    // Split inside a UTF-8 character as real transport chunks may do.
    const input = Buffer.from(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
    const split = input.indexOf(Buffer.from('权限')) + 1;
    bridge.stdin.write(input.subarray(0, split)); bridge.stdin.end(input.subarray(split));
    const exit = await new Promise<number | null>((resolveExit, reject) => { bridge.once('error', reject); bridge.once('exit', resolveExit); });
    expect(stderr).toBe(''); expect(exit).toBe(0);
    const actual = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(actual[0]).toEqual(messages[0]);
    for (const message of actual.slice(1)) {
      expect(message.params).toMatchObject({ text: '权限边界', approvalPolicy: mode === 'full-trust' ? 'never' : 'untrusted', approvalsReviewer: 'user' });
      if (message.method === 'turn/start') expect(message.params.sandboxPolicy).toEqual(mode === 'full-trust' ? { type: 'dangerFullAccess' } : { type: 'readOnly', networkAccess: false });
      else expect(message.params.sandbox).toBe(mode === 'full-trust' ? 'danger-full-access' : 'read-only');
    }
  } finally { if (bridge.exitCode === null) bridge.kill(); await rm(cwd, { recursive: true, force: true }); }
});


it.each(['invalid-json', 'incomplete-eof'])('fails closed and kills a native child ignoring SIGTERM on %s', async failure => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-codex-wire-invalid-'));
  const executable = join(cwd, 'native-codex');
  await writeFile(executable, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});process.stdout.write('ready\\n');process.stdin.resume();setInterval(()=>{},1000);\n`);
  await chmod(executable, 0o755);
  const bridge = spawn(process.execPath, [resolve('packages/acp-client/agents/codex-permission-bridge.mjs'), 'app-server'], {
    env: { ...process.env, dutydeck_codex_executable: executable, dutydeck_codex_permission_mode: 'ask' }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = ''; bridge.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await new Promise<void>((resolveReady, reject) => { bridge.stdout.once('data', () => resolveReady()); bridge.once('error', reject); });
    const exited = new Promise<number | null>((resolveExit, reject) => { bridge.once('error', reject); bridge.once('exit', resolveExit); });
    bridge.stdin.end(failure === 'invalid-json' ? '{invalid}\n' : '{"method":"turn/start"');
    expect(await exited).toBe(137);
    expect(stderr).toContain(failure === 'invalid-json' ? 'CODEX_APPROVAL_PROTOCOL_INVALID' : 'CODEX_APPROVAL_PROTOCOL_INCOMPLETE');
  } finally { if (bridge.exitCode === null) bridge.kill('SIGKILL'); await rm(cwd, { recursive: true, force: true }); }
});

it('refuses to launch native Codex without an explicit Dutydeck policy', async () => {
  const bridge = spawn(process.execPath, [resolve('packages/acp-client/agents/codex-permission-bridge.mjs'), 'app-server'], {
    env: { ...process.env, dutydeck_codex_executable: process.execPath, dutydeck_codex_permission_mode: '' }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = ''; bridge.stderr.on('data', chunk => { stderr += chunk; });
  expect(await new Promise<number | null>(resolveExit => bridge.once('exit', resolveExit))).toBe(2);
  expect(stderr).toContain('CODEX_APPROVAL_POLICY_REQUIRED');
});
