// Run after pnpm build. Exercises the published layout, without workspace packages or tsx.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-package-'));
const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { cwd: temp, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${cmd} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: server }));
  run('tar', ['-xzf', join(temp, packed[0].filename), '-C', temp]);
  const pkg = join(temp, 'package');
  const metadata = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(metadata.dependencies)) {
    const target = join(pkg, 'node_modules', dependency);
    await mkdir(dirname(target), { recursive: true });
    await symlink(await realpath(join(server, 'node_modules', dependency)), target, 'dir');
  }
  assert.equal(Object.keys(metadata.dependencies).some(name => name.startsWith('@dutydeck/')), false);
  await readFile(join(pkg, 'dist/assets/plugin-validation/cli.js'));
  const relayRequests = [];
  const relayServer = createServer(async (request, response) => {
    if (request.method !== 'POST' || !/^\/api\/relay\/sessions\/self\/(ask|ask-result|ask-wait)$/.test(request.url ?? '')) { response.writeHead(404).end(); return; }
    let body;
    try { const chunks = []; for await (const chunk of request) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks)); }
    catch { request.destroy(); return; }
    relayRequests.push({ path: request.url, body });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url.endsWith('/ask-wait')
      ? { status: 'cancelled', askId: 'ask_fixture', reason: 'original attempt ended' }
      : { status: 'answered', answer: 'saved answer', askId: 'ask_fixture', requestId: body.requestId, continuation: request.url.endsWith('/ask') ? 'available' : 'ended', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  });
  await new Promise(resolve => relayServer.listen(0, '127.0.0.1', resolve));
  try {
    const invokeRelay = args => promisify(execFile)(process.execPath, [join(pkg, 'dist/cli.js'), 'session', ...args], { cwd: temp,
      env: { PATH: process.env.PATH, HOME: temp, NO_COLOR: '1', dutydeck_relay_url: `http://127.0.0.1:${relayServer.address().port}/api/relay`, dutydeck_relay_token: 'package-fixture' } });
    const asked = await invokeRelay(['ask', 'Proceed?', '--request-id', 'saved-id']);
    assert.equal(asked.stdout, 'saved answer\n'); assert.equal(asked.stderr, 'requestId: saved-id\n');
    assert.deepEqual(relayRequests[0], { path: '/api/relay/sessions/self/ask', body: { requestId: 'saved-id', question: 'Proceed?' } });
    const result = await invokeRelay(['ask-result', 'saved-id', '--json']);
    assert.equal(JSON.parse(result.stdout).continuation, 'ended');
    await assert.rejects(invokeRelay(['ask-wait', 'saved-id']), error => error.code === 3 && error.stdout === '' && error.stderr.includes('original attempt ended'));
    assert.deepEqual(relayRequests.map(request => request.path.split('/').pop()), ['ask', 'ask-result', 'ask-result', 'ask-wait']);
  } finally { await new Promise(resolve => relayServer.close(resolve)); }
  const source = join(temp, 'source'), database = join(temp, 'data/dutydeck.db');
  await mkdir(join(source, '.dutydeck-plugin'), { recursive: true });
  const fixture = async (version, provider = 'export default api => api.registerHookHandler("notify", async () => ({}));') => {
    await writeFile(join(source, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name: 'pack-check', version, providers: 'provider.mjs', userConfig: { token: { description: 'Authentication token', sensitive: true } } }));
    await writeFile(join(source, 'provider.mjs'), provider);
  };
  const cli = (args, expected = 0, stdin) => {
    const result = spawnSync(process.execPath, [join(pkg, 'dist/cli.js'), '--database', database, 'plugin', ...args], {
      cwd: temp, encoding: 'utf8', input: stdin,
      env: { PATH: process.env.PATH, HOME: temp, NO_COLOR: '1' }
    });
    assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return `${result.stdout}${result.stderr}`;
  };
  await fixture('1.0.0'); cli(['install', source, '--yes', '--json']);
  await fixture('2.0.0'); cli(['update', 'pack-check', '--yes', '--json']);
  let status = JSON.parse(cli(['status', 'pack-check', '--json']));
  assert.ok(JSON.stringify(status).includes('2.0.0'));
  await rm(source, { recursive: true });
  cli(['activate', 'pack-check', '--json']);
  status = JSON.parse(cli(['status', 'pack-check', '--json']));
  assert.equal(status.selected.version, '2.0.0');
  cli(['rollback', 'pack-check', '--json']);
  assert.equal(JSON.parse(cli(['status', 'pack-check', '--json'])).selected.version, '1.0.0');
  await mkdir(join(source, '.dutydeck-plugin'), { recursive: true });
  const canary = 'packaged-provider-secret-canary-7269';
  await fixture('3.0.0', 'export default api => { console.error(api.config.token); throw new Error(api.config.token) }');
  cli(['config', 'pack-check', 'token', '--value-fd', '0', '--json'], 0, canary);
  cli(['update', 'pack-check', '--yes', '--json']);
  const failure = cli(['activate', 'pack-check', '--json'], 1);
  assert.ok(failure.includes('Provider 隔离加载/注册验证失败或超时'));
  assert.equal(failure.includes(canary), false);
  const after = cli(['status', 'pack-check', '--json']);
  assert.equal(after.includes(canary), false);
  assert.equal(JSON.parse(after).candidate.validation.status, 'failed');
  assert.equal(JSON.parse(after).selected.version, '1.0.0');
  console.log('PASS: extracted package v1 → candidate v2 → activate → rollback; bundled Host validation; secret failure redaction');
} finally { await rm(temp, { recursive: true, force: true }); }
