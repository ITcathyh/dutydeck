import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// Controlled Claude PreToolUse command-hook semantics for tests. This is not a
// real Claude executable: only the onFailure behavior under test is emulated.
const args = process.argv.slice(2);
const settingsValue = args[args.indexOf('--settings') + 1] ?? '';
const needle = args[args.indexOf('--hook') + 1] ?? '';
const settings = JSON.parse(settingsValue.trimStart().startsWith('{') ? settingsValue : readFileSync(settingsValue, 'utf8'));
const hook = (settings.hooks?.PreToolUse ?? []).flatMap(group => group.hooks ?? [])
  .find(candidate => String(candidate.command ?? '').includes(needle));
if (!hook) throw new Error(`No PreToolUse command hook contains ${needle}`);

const event = JSON.parse(process.env.CLAUDE_HOOK_TEST_EVENT ?? '{"tool_name":"Bash","tool_input":{"command":"fixture"}}');
const child = spawn('/bin/sh', ['-c', hook.command], {
  detached: true,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdin.end(JSON.stringify(event));
let timedOut = false;
const timeoutMs = Number(process.env.CLAUDE_HOOK_TEST_TIMEOUT_MS ?? 50);
const timer = setTimeout(() => {
  timedOut = true;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}, timeoutMs);
const failure = await new Promise(resolve => {
  child.once('error', resolve);
  child.once('close', (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);

let denied = false;
if (!timedOut && !failure?.code && !failure?.signal && !failure?.message) {
  try { denied = JSON.parse(stdout).hookSpecificOutput?.permissionDecision === 'deny'; } catch {}
}
const explicitBlock = !timedOut && failure?.code === 2;
const blocked = denied || explicitBlock || ((timedOut || failure?.code !== 0 || failure?.signal || failure?.message) && hook.onFailure === 'block');
const result = {
  blocked,
  timedOut,
  onFailure: hook.onFailure,
  exit: failure,
  stdout: stdout.slice(0, 1000),
  stderr: stderr.slice(0, 1000),
};
if (!blocked && process.env.CLAUDE_HOOK_TEST_TOOL_MARKER) writeFileSync(process.env.CLAUDE_HOOK_TEST_TOOL_MARKER, 'tool ran');
process.stdout.write(JSON.stringify(result));
process.exitCode = blocked ? 2 : 0;
