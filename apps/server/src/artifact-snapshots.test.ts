import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, stat, readdir, appendFile, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalExecutionJson, type ArtifactSnapshotReference, type TaskRequestV1 } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { LocalFileSecretProvider, secretDirectoryForDatabase } from '@dutydeck/secret-provider';
import { ArtifactSnapshots, artifactSnapshotLimit, artifactSnapshotPrefix, artifactPreviewLimit } from './artifact-snapshots.js';
import { buildApp } from './app.js';
import * as bounded from './bounded-file.js';
import { PluginStore } from './plugins/store.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
async function fixture(dataWithinCwd = false) {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-snapshots-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); await mkdir(workspace); await mkdir(join(root, 'data'));
  const cwd = dataWithinCwd ? root : workspace;
  const database = join(root, 'data/dutydeck.db');
  const repos = createRepositories(database); cleanups.push(() => repos.close()); repos.execution.upgradeLegacy();
  const claim = repos.control.attachRuntime('snapshot-test'); cleanups.push(() => claim.release());
  const execution = repos.execution.bind(claim);
  const time = new Date().toISOString();
  for (const id of ['s', 'other']) execution.createSession({ id, runId: 'run', agentId: 'agent', state: 'idle', cwd, createdAt: time, updatedAt: time });
  const fence = { sessionId: 's', runId: 'run' };
  const content = { version: 2 as const, prompt: 'create', executionContext: { agentPrompt: 'create' }, executionOptions: { permissionMode: 'ask' as const }, contentSources: [] };
  const request: TaskRequestV1 = { version: 1, namespace: 'runtime', key: 'create', sessionId: 's', actor: { kind: 'unspecified' }, prompt: 'create', mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: null };
  const task = execution.acceptTask(fence, request, { ...content, digest: digest(canonicalExecutionJson(content)) }, 'back').task!;
  const attempt = execution.claimNext(fence)!.attempt!;
  const reference = async (uri: string, name = 'report.html', extra: { status?: string; type?: 'text' | 'tool_result'; role?: string } = {}): Promise<ArtifactSnapshotReference> => {
    const latest = repos.execution.getTaskExecution(task.id)!.currentAttempt!;
    const event = execution.appendEvent({ ...fence, taskId: task.id, attemptId: attempt.attemptId, expectedRevision: latest.revision }, { id: `event-${Math.random()}`, type: extra.type ?? 'tool_result', data: { status: extra.status ?? 'completed', ...(extra.role ? { role: extra.role } : {}), parts: [{ type: 'resource_link', uri, name, mimeType: 'text/html' }] } });
    return { taskId: task.id, attemptId: attempt.attemptId, eventId: event.id, sequence: event.sequence, partIndex: 0, revision: `event:${event.id}:${event.sequence}:0` };
  };
  const snapshots = new ArtifactSnapshots(repos, database);
  return { root, cwd, database, repos, reference, snapshots, execution, task, attempt };
}

it('captures current bytes with stable identity, restrictive permissions and hash; later source changes cannot change an existing snapshot', async () => {
  const f = await fixture(); const source = join(f.cwd, 'report.html');
  await writeFile(source, '<script>window.pwned=true</script>');
  const ref = await f.reference(pathToFileURL(source).href, '分析\r\n"报告".html');
  const [one, duplicate] = await Promise.all([f.snapshots.capture('s', ref), f.snapshots.capture('s', ref)]);
  expect(duplicate.id).toBe(one.id); expect(duplicate.capturedAt).toBe(one.capturedAt);
  expect(one.name).toBe('分析__"报告".html'); expect(one.mimeType).toBe('text/plain');
  expect(one.sha256).toBe(digest('<script>window.pwned=true</script>'));
  expect((await stat(f.snapshots.directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(f.snapshots.directory, `${one.id}.bin`))).mode & 0o777).toBe(0o600);
  expect(await readdir(f.snapshots.directory)).toEqual([`${one.id}.bin`]);
  await writeFile(source, 'new file content');
  expect((await f.snapshots.read('s', one.id)).data.toString()).toBe('<script>window.pwned=true</script>');
  const changed = await f.snapshots.capture('s', ref); expect(changed.id).not.toBe(one.id);
  expect((await f.snapshots.list('s')).length).toBe(2);
  expect((await f.snapshots.read('s', changed.id)).data.toString()).toBe('new file content');
  const longName = await f.snapshots.capture('s', await f.reference('report.html', '名'.repeat(179) + '😀' + 'x'.repeat(200)));
  expect(longName.name.length).toBeLessThanOrEqual(180); expect(() => encodeURIComponent(longName.name)).not.toThrow();
  await expect(f.snapshots.read('other', one.id)).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
});

it('validates original event, task, attempt and revision and never treats failed/user results, remote URLs or private receipts as local files', async () => {
  const f = await fixture(); await writeFile(join(f.cwd, 'report.txt'), 'hello'); const ref = await f.reference('report.txt');
  await expect(f.snapshots.capture('other', ref)).rejects.toMatchObject({ code: 'ARTIFACT_REFERENCE_NOT_FOUND' });
  for (const bad of [{ eventId: 'missing' }, { sequence: ref.sequence + 1 }, { revision: 'stale' }, { taskId: 'other-task' }, { attemptId: 'other-attempt' }, { partIndex: 1 }]) await expect(f.snapshots.capture('s', { ...ref, ...bad })).rejects.toBeInstanceOf(Error);
  await expect(f.snapshots.capture('s', await f.reference('report.txt', 'bad', { status: 'failed' }))).rejects.toMatchObject({ code: 'ARTIFACT_REFERENCE_STALE' });
  await expect(f.snapshots.capture('s', await f.reference('report.txt', 'bad', { type: 'text', role: 'user' }))).rejects.toMatchObject({ code: 'ARTIFACT_REFERENCE_STALE' });
  for (const uri of ['https://example.invalid/file', 'dutydeck-result:private', 'data:text/plain,secret']) await expect(f.snapshots.capture('s', await f.reference(uri))).rejects.toMatchObject({ code: 'ARTIFACT_LOCAL_ONLY' });
  expect(await f.snapshots.list('s')).toEqual([]);
});

it('rejects outside paths, final and ancestor symlinks, hardlinks, FIFOs, directories, credential files and oversized files', async () => {
  const f = await fixture();
  const outside = join(f.root, 'outside.txt'); await writeFile(outside, 'outside');
  await symlink(outside, join(f.cwd, 'link.txt')); await symlink(f.root, join(f.cwd, 'parent-link'));
  await link(outside, join(f.cwd, 'hard.txt'));
  await promisify(execFile)('mkfifo', [join(f.cwd, 'pipe')]);
  await mkdir(join(f.cwd, 'directory'));
  await writeFile(join(f.cwd, '.env'), 'TOP_SECRET=secret');
  await writeFile(join(f.cwd, 'large'), Buffer.alloc(artifactSnapshotLimit + 1));
  for (const path of [outside, '../outside.txt', 'link.txt', 'parent-link/outside.txt', 'hard.txt', 'pipe', 'directory', '.env', 'large']) await expect(f.snapshots.capture('s', await f.reference(path))).rejects.toBeInstanceOf(Error);
  expect(await f.snapshots.list('s')).toEqual([]);
});

it('detects source writes and ancestor moves during reading and fails closed on unsupported platforms', async () => {
  const f = await fixture(); const source = join(f.cwd, 'report.txt'); await writeFile(source, 'before'); const ref = await f.reference(source);
  const read = bounded.readBoundedBytes;
  vi.spyOn(bounded, 'readBoundedBytes').mockImplementationOnce(async (...args) => { const data = await read(...args); await appendFile(source, 'after'); return data; });
  await expect(f.snapshots.capture('s', ref)).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' });
  await mkdir(join(f.cwd, 'moving')); await writeFile(join(f.cwd, 'moving/report.txt'), 'move'); const moving = await f.reference('moving/report.txt');
  vi.spyOn(bounded, 'readBoundedBytes').mockImplementationOnce(async (...args) => { const data = await read(...args); await rename(join(f.cwd, 'moving'), join(f.root, 'moved-out')); return data; });
  await expect(f.snapshots.capture('s', moving)).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' });
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  await expect(f.snapshots.capture('s', ref)).rejects.toMatchObject({ code: 'ARTIFACT_PLATFORM_UNSUPPORTED' });
});

it('verifies every stored blob, fails closed for corrupt/missing manifests and files, and bounds previews including empty and binary files', async () => {
  const f = await fixture(); const source = join(f.cwd, 'report.svg'); await writeFile(source, '<svg onload="alert(1)">' + 'a'.repeat(artifactPreviewLimit * 2));
  const ref = await f.reference(source); const snapshot = await f.snapshots.capture('s', ref);
  const preview = await f.snapshots.preview('s', snapshot.id); expect(preview.truncated).toBe(true); expect(preview.text!.length).toBe(artifactPreviewLimit);
  await writeFile(join(f.snapshots.directory, `${snapshot.id}.bin`), 'tampered');
  await expect(f.snapshots.read('s', snapshot.id)).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED' });
  await rm(join(f.snapshots.directory, `${snapshot.id}.bin`)); await expect(f.snapshots.read('s', snapshot.id)).rejects.toBeInstanceOf(Error);
  const key = artifactSnapshotPrefix + snapshot.id;
  await f.repos.config.set(key, JSON.stringify({ ...snapshot, sha256: '0'.repeat(64) })); await expect(f.snapshots.read('s', snapshot.id)).rejects.toMatchObject({ code: 'ARTIFACT_METADATA_INVALID' });
  await f.repos.config.set(key, JSON.stringify({ sessionId: 's', broken: true })); await expect(f.snapshots.list('s')).rejects.toMatchObject({ code: 'ARTIFACT_METADATA_INVALID' });
  await f.repos.config.set(key, '{invalid'); await expect(f.snapshots.read('s', snapshot.id)).rejects.toMatchObject({ code: 'ARTIFACT_METADATA_INVALID' });
  await writeFile(source, Buffer.alloc(0)); const empty = await f.snapshots.capture('s', ref); expect(empty.size).toBe(0); expect((await f.snapshots.preview('s', empty.id)).text).toBe('');
  await writeFile(source, Buffer.from([0, 1, 2])); const binary = await f.snapshots.capture('s', ref); expect(binary.mimeType).toBe('application/octet-stream'); expect((await f.snapshots.preview('s', binary.id)).text).toBeUndefined();
});

it('serves real HTTP capture/preview/attachment bytes only with owner plus session access; share/task credentials and client paths are rejected', async () => {
  const f = await fixture(); await writeFile(join(f.cwd, 'report.html'), '<script>alert("x")</script>'); const ref = await f.reference('report.html', '中文\r\n"report".html');
  let sessionAllowed = true;
  const app = await buildApp({} as any, { artifactSnapshots: { service: f.snapshots, authorize: async request => request.headers.authorization === 'Bearer owner' && sessionAllowed } }); cleanups.push(() => app.close());
  const url = await app.listen({ host: '127.0.0.1', port: 0 }); const path = `${url}/api/sessions/s/artifact-snapshots`; const headers = { authorization: 'Bearer owner', 'content-type': 'application/json' };
  const captured = await fetch(path, { method: 'POST', headers, body: JSON.stringify(ref) }); expect(captured.status).toBe(200); const snapshot = await captured.json();
  const listed = await fetch(path, { headers }); expect((await listed.json()).snapshots[0].id).toBe(snapshot.id);
  const preview = await fetch(`${path}/${snapshot.id}/preview`, { headers }); expect((await preview.json()).text).toContain('<script>'); expect(preview.headers.get('content-type')).toContain('application/json');
  const download = await fetch(`${path}/${snapshot.id}/download`, { headers }); expect(download.status).toBe(200); expect(await download.text()).toBe('<script>alert("x")</script>');
  expect(download.headers.get('content-type')).toBe('application/octet-stream'); expect(download.headers.get('content-disposition')).toMatch(/^attachment;.*filename\*=UTF-8''/); expect(download.headers.get('content-disposition')).not.toMatch(/[\r\n]/);
  expect(download.headers.get('x-content-type-options')).toBe('nosniff'); expect(download.headers.get('content-security-policy')).toContain('sandbox'); expect(download.headers.get('cache-control')).toBe('no-store');
  for (const suffix of ['', `/${snapshot.id}/preview`, `/${snapshot.id}/download`]) {
    expect((await fetch(`${path}${suffix}?share=capability`, { headers })).status).toBe(403);
    expect((await fetch(`${path}${suffix}`, { headers: { ...headers, 'x-dutydeck-tool-turn': 'task' } })).status).toBe(403);
    expect((await fetch(`${path}${suffix}`, { headers: { authorization: 'Bearer v1.task' } })).status).toBe(403);
    expect((await fetch(`${path}${suffix}`)).status).toBe(403);
  }
  expect((await fetch(path, { method: 'POST', headers, body: JSON.stringify({ ...ref, path: '/etc/passwd' }) })).status).toBe(400);
  expect((await fetch(`${path}?share=capability`, { method: 'POST', headers, body: JSON.stringify(ref) })).status).toBe(403);
  expect((await fetch(path, { method: 'POST', headers: { ...headers, 'x-dutydeck-result-turn': 'task' }, body: JSON.stringify(ref) })).status).toBe(403);
  expect((await fetch(`${url}/api/sessions/other/artifact-snapshots/${snapshot.id}/download`, { headers })).status).toBe(404);
  sessionAllowed = false; expect((await fetch(path, { method: 'POST', headers, body: JSON.stringify(ref) })).status).toBe(403); expect((await fetch(`${path}/${snapshot.id}/download`, { headers })).status).toBe(403);
});

it('protects the real secret provider in a custom runtime directory including aliases, while ordinary output siblings remain usable', async () => {
  const f = await fixture(true);
  const provider = new LocalFileSecretProvider(secretDirectoryForDatabase(f.database), { createDirectory: true });
  const referenceKey = 'plugin.review.synthetic';
  provider.writeExclusive(referenceKey, Buffer.from('synthetic-provider-canary'));
  expect(provider.inspect(referenceKey).availability).toBe('available');
  const secret = join(provider.directory, `${referenceKey}.secret`);
  const ref = await f.reference(pathToFileURL(secret).href, 'report.txt');
  const alias = join(f.root, 'runtime-alias'); await symlink(dirname(f.database), alias);
  const aliased = new ArtifactSnapshots(f.repos, join(alias, basename(f.database)));
  for (const service of [f.snapshots, aliased]) {
    await expect(service.capture('s', ref)).rejects.toMatchObject({ code: 'ARTIFACT_PROTECTED', statusCode: 403 });
    for (const path of [f.database, `${f.database}-wal`, `${f.database}-shm`]) await expect(service.capture('s', await f.reference(path))).rejects.toMatchObject({ code: 'ARTIFACT_PROTECTED', statusCode: 403 });
  }
  const aliasRef = await f.reference(pathToFileURL(join(alias, 'secrets', `${referenceKey}.secret`)).href, 'report.txt');
  await expect(aliased.capture('s', aliasRef)).rejects.toMatchObject({ code: 'ARTIFACT_PROTECTED', statusCode: 403 });
  const app = await buildApp({} as any, { artifactSnapshots: { service: aliased, authorize: async () => true } }); cleanups.push(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/sessions/s/artifact-snapshots', payload: ref });
  expect(response.statusCode).toBe(403); expect(response.json().error.code).toBe('ARTIFACT_PROTECTED');
  expect(await f.repos.config.list!(artifactSnapshotPrefix)).toEqual([]);
  expect(await readdir(f.snapshots.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).toEqual([]);
  const report = join(dirname(f.database), 'report.secret'); await writeFile(report, 'ordinary sibling output');
  const allowed = await aliased.capture('s', await f.reference(report));
  expect((await aliased.read('s', allowed.id)).data.toString()).toBe('ordinary sibling output');
  await mkdir(join(f.root, 'secrets')); await writeFile(join(f.root, 'secrets/report.txt'), 'ordinary workspace folder');
  const unrelated = await aliased.capture('s', await f.reference('secrets/report.txt'));
  expect((await aliased.read('s', unrelated.id)).data.toString()).toBe('ordinary workspace folder');
  await expect(aliased.capture('s', await f.reference(join(aliased.directory, `${allowed.id}.bin`)))).rejects.toMatchObject({ code: 'ARTIFACT_PROTECTED', statusCode: 403 });
});

it('protects the actual plugin trigger token store and private insight copies under a custom data directory', async () => {
  const f = await fixture(true);
  const source = join(f.root, 'source-plugin');
  await mkdir(join(source, '.dutydeck-plugin'), { recursive: true }); await mkdir(join(source, 'triggers'));
  await writeFile(join(source, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name: 'private-review' }));
  await writeFile(join(source, 'triggers/ping.json'), JSON.stringify({ auth: { type: 'token' }, target: { botAppId: 'cli_review', chatId: 'oc_review' }, prompt: '{{payload.text}}' }));
  const store = new PluginStore(dirname(f.database)); await store.install(source);
  const issued = await store.ensureTriggerToken('private-review', 'ping');
  expect(issued.created).toBe(true); expect(store.triggerToken('private-review', 'ping')).toBe(issued.token);
  const tokenFile = join(store.pluginsDir, '.trigger-tokens.json');
  expect(JSON.parse(await readFile(tokenFile, 'utf8'))['private-review/ping']).toBe(issued.token);
  const tokenRef = await f.reference(pathToFileURL(tokenFile).href, 'report.txt');
  await expect(f.snapshots.capture('s', tokenRef)).rejects.toMatchObject({ code: 'ARTIFACT_PROTECTED', statusCode: 403 });
  const insightDirectory = join(dirname(f.database), 'insight-tmp/request'); await mkdir(insightDirectory, { recursive: true });
  const insightFile = join(insightDirectory, 'snapshot-0.jsonl'); await writeFile(insightFile, '{"private":"raw native session"}\n');
  await expect(f.snapshots.capture('s', await f.reference(insightFile, 'report.txt'))).rejects.toMatchObject({ code: 'ARTIFACT_PROTECTED', statusCode: 403 });
  const alias = join(f.root, 'data-alias'); await symlink(dirname(f.database), alias);
  const aliased = new ArtifactSnapshots(f.repos, join(alias, basename(f.database)));
  for (const path of [tokenFile, join(alias, 'plugins/.trigger-tokens.json'), insightFile, join(alias, 'insight-tmp/request/snapshot-0.jsonl')]) await expect(aliased.capture('s', await f.reference(path, 'report.txt'))).rejects.toMatchObject({ code: 'ARTIFACT_PROTECTED', statusCode: 403 });
  const app = await buildApp({} as any, { artifactSnapshots: { service: aliased, authorize: async () => true } }); cleanups.push(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/sessions/s/artifact-snapshots', payload: tokenRef });
  expect(response.statusCode).toBe(403); expect(response.json().error.code).toBe('ARTIFACT_PROTECTED');
  expect(await f.repos.config.list!(artifactSnapshotPrefix)).toEqual([]);
  expect(await readdir(f.snapshots.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).toEqual([]);
  const relocated = join(f.root, 'actual-plugin-state'); await rename(store.pluginsDir, relocated); await symlink(relocated, store.pluginsDir);
  expect(store.triggerToken('private-review', 'ping')).toBe(issued.token);
  await expect(aliased.capture('s', await f.reference(join(relocated, '.trigger-tokens.json'), 'report.txt'))).rejects.toMatchObject({ code: 'ARTIFACT_PROTECTED', statusCode: 403 });
  for (const name of ['plugins', 'insight-tmp']) {
    await mkdir(join(f.root, name)); const output = join(f.root, name, 'report.txt'); await writeFile(output, `ordinary ${name} workspace output`);
    const allowed = await aliased.capture('s', await f.reference(output));
    expect((await aliased.read('s', allowed.id)).data.toString()).toBe(`ordinary ${name} workspace output`);
  }
});
