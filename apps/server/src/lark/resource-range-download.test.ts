import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createLarkCardService } from './service.js';
import { materializeLarkResources } from './session-resolver.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const temporary = async () => { const path = await mkdtemp(join(tmpdir(), 'dutydeck-range-test-')); cleanups.push(() => rm(path, { recursive: true, force: true })); return path; };
const env = (suffix: string) => ({ LARK_APP_ID: `cli_range_${suffix}`, LARK_APP_SECRET: 'synthetic', LARK_API_QPS: '10000', LARK_API_BURST: '10000', LARK_API_RETRY_MAX_ATTEMPTS: '3', LARK_API_RETRY_BASE_MS: '1', LARK_API_RETRY_MAX_MS: '1' });
const error = (code = 234037, status = 400) => Response.json({ code, msg: 'synthetic resource error' }, { status });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = (offset: number, length: number) => { const data = new Uint8Array(length); for (let index = 0; index < length; index++) data[index] = (offset + index) % 251; return data; };
const stream = (start: number, length: number) => new ReadableStream<Uint8Array>({ pull(controller) {
  const count = Math.min(64 * 1024, length); if (!count) { controller.close(); return; }
  controller.enqueue(bytes(start, count)); start += count; length -= count;
} });
const setup = (name: string, resource: (range: string | null, init: RequestInit) => Response | Promise<Response>) => {
  const requests: Array<{ url: string; range: string | null; authorization: string | null }> = [];
  const service = createLarkCardService(env(name), (async (url, init) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'same-app-token', expire: 7200 });
    const headers = new Headers(init?.headers), range = headers.get('range');
    requests.push({ url: String(url), range, authorization: headers.get('authorization') });
    return resource(range, init!);
  }) as typeof fetch); cleanups.push(() => service.close());
  return { service, requests };
};
const valid = (range: string, total: number) => {
  const [, startText, endText] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
  const start = Number(startText), end = Number(endText);
  return new Response(stream(start, end - start + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${total}`, 'content-type': 'application/octet-stream' } });
};

it('materializes a large file via the real service with bounded streams, exact content and the same identity/URL', async () => {
  const total = 100_000_003;
  const h = setup('large', range => range ? valid(range, total) : error());
  const message = `om_range_${Date.now()}`;
  const directory = join(tmpdir(), 'dutydeck', 'lark-resources', message); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const result = await materializeLarkResources(message, 'read file', [{ type: 'file', key: 'file_fake', label: '附件', fileName: 'fixture.bin' }], h.service);
  expect(result).toContain('已下载到本地');
  const path = result.match(/已下载到本地：(.+?)。/)![1]!;
  const actual = await readFile(path);
  const expected = createHash('sha256'); for (let offset = 0; offset < total; offset += 64 * 1024) expected.update(bytes(offset, Math.min(64 * 1024, total - offset)));
  expect(actual.length).toBe(total); expect(hash(actual)).toBe(expected.digest('hex'));
  expect(h.requests[0]!.range).toBeNull(); expect(h.requests[1]!.range).toBe('bytes=0-0');
  expect(new Set(h.requests.map(request => request.url)).size).toBe(1);
  expect(h.requests.every(request => request.authorization === 'Bearer same-app-token')).toBe(true);
  for (const request of h.requests.slice(1)) { const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(request.range!)!; expect(Number(end) - Number(start) + 1).toBeLessThanOrEqual(32_000_000); }
  expect((await readdir(directory)).filter(name => name.includes('.partial'))).toEqual([]);
}, 30_000);

it.each(['missing-header', 'wrong-start', 'wrong-end', 'changed-total', 'short', 'long', 'ignored-range', 'unsatisfiable'])(
  'rejects %s responses and removes every partial file', async scenario => {
    const directory = await temporary(); let ranges = 0;
    const h = setup(scenario, range => {
      if (!range) return error(); ranges++;
      if (ranges === 1) return valid(range, 7);
      if (scenario === 'ignored-range') return new Response('full body');
      if (scenario === 'unsatisfiable') return error(234046, 416);
      const header = scenario === 'missing-header' ? undefined : scenario === 'wrong-start' ? 'bytes 0-6/7' : scenario === 'wrong-end' ? 'bytes 1-5/7' : scenario === 'changed-total' ? 'bytes 1-6/8' : 'bytes 1-6/7';
      return new Response(new Uint8Array(scenario === 'short' ? 5 : scenario === 'long' ? 7 : 6), { status: 206, headers: header ? { 'content-range': header } : {} });
    });
    await expect(h.service.downloadMessageResourceToFile('om_input', 'file_fake', join(directory, 'result.bin'))).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

it('retries a broken streamed slice at its exact offset without duplicating bytes', async () => {
  const directory = await temporary(); let broken = false;
  const h = setup('retry', range => {
    if (!range) return error();
    if (range !== 'bytes=0-0' && !broken) {
      broken = true; let sent = false;
      return new Response(new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(bytes(1, 2)); } else controller.error(new TypeError('stream connection lost')); } }),
        { status: 206, headers: { 'content-range': 'bytes 1-6/7' } });
    }
    return valid(range, 7);
  });
  const path = join(directory, 'result.bin');
  await h.service.downloadMessageResourceToFile('om_input', 'file_fake', path);
  expect(await readFile(path)).toEqual(Buffer.from(bytes(0, 7)));
  expect(h.requests.map(request => request.range)).toEqual([null, 'bytes=0-0', 'bytes=1-6', 'bytes=1-6']);
});

it.each([234002, 234038, 234040, 234041, 234043])('never uses Range to bypass resource error %s', async code => {
  const directory = await temporary(); const h = setup(`permission_${code}`, () => error(code, 403));
  await expect(h.service.downloadMessageResourceToFile('om_input', 'file_fake', join(directory, 'file.bin'))).rejects.toThrow();
  expect(h.requests.map(request => request.range)).toEqual([null]); expect(await readdir(directory)).toEqual([]);
});

it.each([0, 3])('streams an ordinary %s-byte file without Range and preserves content type', async size => {
  const directory = await temporary(); const h = setup(`small_${size}`, () => new Response(bytes(0, size), { headers: { 'content-type': 'application/pdf' } }));
  const path = join(directory, 'file.pdf');
  expect(await h.service.downloadMessageResourceToFile('om_input', 'file_fake', path)).toEqual({ contentType: 'application/pdf' });
  expect(await readFile(path)).toEqual(Buffer.from(bytes(0, size))); expect(h.requests.map(request => request.range)).toEqual([null]);
});

it('keeps image size errors on the full-download path', async () => {
  const h = setup('image', () => error());
  await expect(h.service.downloadMessageResource('om_input', 'img_fake', 'image')).rejects.toMatchObject({ details: { upstreamCode: 234037 } });
  expect(h.requests.map(request => request.range)).toEqual([null]);
});

it('aborts a stalled body and removes partial data before returning', async () => {
  const directory = await temporary(); const controller = new AbortController(); let cancelled = false;
  const h = setup('abort', range => {
    if (!range) return error(); if (range === 'bytes=0-0') return valid(range, 7);
    return new Response(new ReadableStream<Uint8Array>({ start(output) { output.enqueue(bytes(1, 2)); setTimeout(() => controller.abort(new DOMException('caller cancelled', 'AbortError')), 10); }, cancel() { cancelled = true; } }),
      { status: 206, headers: { 'content-range': 'bytes 1-6/7' } });
  });
  await expect(h.service.downloadMessageResourceToFile('om_input', 'file_fake', join(directory, 'file.bin'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelled).toBe(true); expect(await readdir(directory)).toEqual([]);
});

it.each(['ordinary', 'range'])('enforces the local 512 MiB limit for %s metadata and preserves an existing complete destination', async mode => {
  const directory = await temporary(); const path = join(directory, 'existing.bin'); await writeFile(path, 'keep-complete');
  const h = setup(`cap_${mode}`, range => mode === 'ordinary'
    ? new Response('x', { headers: { 'content-length': String(512 * 1024 * 1024 + 1) } })
    : range ? new Response('x', { status: 206, headers: { 'content-range': `bytes 0-0/${512 * 1024 * 1024 + 1}` } }) : error());
  await expect(h.service.downloadMessageResourceToFile('om_input', 'file_fake', path)).rejects.toThrow('512 MiB');
  expect(await readFile(path, 'utf8')).toBe('keep-complete'); expect(await readdir(directory)).toEqual(['existing.bin']);
});

it('bounds cumulative streamed bytes even if Content-Length is absent', async () => {
  const { writeResourceStream, larkResourceFileLimitBytes } = await import('./resource-range-download.js');
  const write = vi.fn();
  await expect(writeResourceStream(new Response('abc'), { write } as any, larkResourceFileLimitBytes - 2, new AbortController().signal)).rejects.toThrow('512 MiB');
  expect(write).not.toHaveBeenCalled();
});

it('allows size negotiation with retries disabled but never retries a subsequent slice failure', async () => {
  const directory = await temporary();
  const requests: Array<string | null> = [];
  const service = createLarkCardService({ ...env('budget'), LARK_API_RETRY_MAX_ATTEMPTS: '0' }, (async (url, init) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fake', expire: 7200 });
    const range = new Headers(init?.headers).get('range'); requests.push(range);
    if (!range) return error(); if (range === 'bytes=0-0') return valid(range, 7);
    return new Response('temporary failure', { status: 503 });
  }) as typeof fetch); cleanups.push(() => service.close());
  await expect(service.downloadMessageResourceToFile('om_input', 'file_fake', join(directory, 'file.bin'))).rejects.toThrow();
  expect(requests).toEqual([null, 'bytes=0-0', 'bytes=1-6']); expect(await readdir(directory)).toEqual([]);
});

it('keeps the original deadline while a slice body stalls', async () => {
  const directory = await temporary(); let cancelled = false;
  const service = createLarkCardService({ ...env('deadline'), LARK_API_REQUEST_TIMEOUT_MS: '40' }, (async (url, init) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fake', expire: 7200 });
    const range = new Headers(init?.headers).get('range');
    if (!range) return error(); if (range === 'bytes=0-0') return valid(range, 7);
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 206, headers: { 'content-range': 'bytes 1-6/7' } });
  }) as typeof fetch); cleanups.push(() => service.close());
  await expect(service.downloadMessageResourceToFile('om_input', 'file_fake', join(directory, 'file.bin'))).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(cancelled).toBe(true); expect(await readdir(directory)).toEqual([]);
});

it.each(['token', 'resource'])('propagates caller cancellation while waiting for %s response headers', async stage => {
  const directory = await temporary(), controller = new AbortController();
  let aborted = false;
  const service = createLarkCardService(env(`headers_${stage}`), (async (url, init) => {
    if (stage === 'resource' && String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fake', expire: 7200 });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal!.reason); }, { once: true });
      setTimeout(() => controller.abort(new DOMException('caller cancelled', 'AbortError')), 5);
    });
  }) as typeof fetch); cleanups.push(() => service.close());
  await expect(service.downloadMessageResourceToFile('om_input', 'file_fake', join(directory, 'file.bin'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(aborted).toBe(true); expect(await readdir(directory)).toEqual([]);
});

it('downloads all slices with transient retries disabled because 234037 only negotiates the protocol', async () => {
  const directory = await temporary();
  const ranges: Array<string | null> = [];
  const service = createLarkCardService({ ...env('zero_retry_success'), LARK_API_RETRY_MAX_ATTEMPTS: '0' }, (async (url, init) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fake', expire: 7200 });
    const range = new Headers(init?.headers).get('range'); ranges.push(range);
    if (range) { expect(init?.redirect).toBe('error'); return valid(range, 7); }
    return error();
  }) as typeof fetch); cleanups.push(() => service.close());
  const path = join(directory, 'file.bin'); await service.downloadMessageResourceToFile('om_input', 'file_fake', path);
  expect(await readFile(path)).toEqual(Buffer.from(bytes(0, 7))); expect(ranges).toEqual([null, 'bytes=0-0', 'bytes=1-6']);
});

it('preserves a permission rejection during a later slice and never switches identity or publishes a partial file', async () => {
  const directory = await temporary();
  const h = setup('later_permission', range => !range ? error() : range === 'bytes=0-0' ? valid(range, 7) : error(234040, 403));
  await expect(h.service.downloadMessageResourceToFile('om_input', 'file_fake', join(directory, 'file.bin'))).rejects.toMatchObject({ details: { upstreamCode: 234040, upstreamHttpStatus: 403 } });
  expect(h.requests.map(request => request.range)).toEqual([null, 'bytes=0-0', 'bytes=1-6']);
  expect(h.requests.every(request => request.authorization === 'Bearer same-app-token')).toBe(true); expect(await readdir(directory)).toEqual([]);
});

it('bounds and cancels oversized error responses instead of buffering them or treating a hidden code as size negotiation', async () => {
  const directory = await temporary(); let cancelled = false;
  const h = setup('error_body_limit', () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(64 * 1024))); }, cancel() { cancelled = true; } }), { status: 403 }));
  await expect(h.service.downloadMessageResourceToFile('om_input', 'file_fake', join(directory, 'file.bin'))).rejects.toMatchObject({ details: { upstreamHttpStatus: 403 } });
  expect(cancelled).toBe(true); expect(h.requests.map(request => request.range)).toEqual([null]); expect(await readdir(directory)).toEqual([]);
});
