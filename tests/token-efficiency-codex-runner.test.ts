import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const script = fileURLToPath(new URL('../scripts/token-efficiency-codex-runner.mts', import.meta.url));
const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));

async function run(mode = 'valid') {
  const workspace = await mkdtemp(join(tmpdir(), 'dutydeck-provider-runner-test-')); directories.push(workspace);
  await writeFile(join(workspace, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
console.error('fixture provider diagnostics');
const mode = process.env.FAKE_CODEX_MODE;
const emit = event => console.log(JSON.stringify(event));
emit({type:'thread.started', thread_id:'fixture-thread'});
emit({type:'turn.started'});
if (mode === 'disabled_code_warning') emit({type:'item.completed', item:{type:'error', message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable \`features.code_mode_host\` and install \`codex-code-mode-host\`.'}});
if (mode === 'other_error') emit({type:'item.completed', item:{type:'error', message:'different error'}});
if (mode === 'tool') emit({type:'item.started', item:{type:'command_execution', command:'forbidden'}});
else {
 emit({type:'item.completed', item:{type:'agent_message', text:'{"day":"Friday"}'}});
 const usage = {input_tokens:100, cached_input_tokens:20, cache_write_input_tokens:0, output_tokens:10};
 if (mode === 'missing_cache_write') delete usage.cache_write_input_tokens;
 if (mode === 'cache_write_nonzero') usage.cache_write_input_tokens = 5;
 emit({type:'turn.completed', usage});
}
`, { mode: 0o755 });
  const request = { version: 1, policy: 'optimized', config: { model: 'fixture-requested-model', protocol: 'codex-jsonl', reasoningEffort: 'high' }, workspace, inputDigest: 'frozen',
    case: { id: 'fixture-case', input: { promptSource: 'test fixtures', prompts: { legacy: 'old prompt', optimized: 'new prompt' } } } };
  const execution = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, script], { env: { ...process.env, PATH: `${workspace}:${process.env.PATH}`, FAKE_CODEX_MODE: mode }, cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(request));
  });
  return { ...execution, args: JSON.parse(await readFile(join(workspace, 'argv.json'), 'utf8')) as string[] };
}

it('uses safe argv, separates diagnostics, and preserves provider usage and requested-model provenance', async () => {
  const result = await run();
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('fixture provider diagnostics');
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({ output: { day: 'Friday' }, executionScope: 'model_no_tools', attempts: [{ usage: { input: 80, cacheRead: 20, cacheWrite: 0, output: 10 }, rawUsage: { modelSource: 'requested', provider: { input_tokens: 100 } } }] });
  expect(result.args).toContain('--ignore-user-config'); expect(result.args).toContain('--ignore-rules'); expect(result.args).toContain('--ephemeral');
  expect(result.args).toContain('read-only'); expect(result.args).toContain('mcp_servers={}'); expect(result.args).toContain('web_search="disabled"');
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'browser_use', 'computer_use', 'code_mode_host', 'image_generation', 'multi_agent', 'skill_search']) expect(result.args[result.args.indexOf(feature) - 1]).toBe('--disable');
  expect(result.args.at(-1)).toContain('new prompt');
});

it('rejects emitted tool events even when the model was instructed not to call tools', async () => {
  const result = await run('tool');
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Tool/event forbidden');
});

it.each(['missing_cache_write', 'cache_write_nonzero'])('leaves %s normalization unavailable', async mode => {
  const result = await run(mode);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).attempts[0]).not.toHaveProperty('usage');
});

it('retains the exact disabled-code-host warning while rejecting other errors', async () => {
  const warning = await run('disabled_code_warning');
  expect(warning.code).toBe(0);
  expect(JSON.parse(warning.stdout).attempts[0].rawUsage.events).toContainEqual(expect.objectContaining({ item: expect.objectContaining({ type: 'error' }) }));
  const error = await run('other_error');
  expect(error.code).not.toBe(0);
});
