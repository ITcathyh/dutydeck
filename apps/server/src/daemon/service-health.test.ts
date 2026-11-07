import { describe, expect, it } from 'vitest';
import { waitForServiceHealth, type ServiceControl } from './command.js';

/** 新主进程已换上；按调用顺序回放 /health/ready 的响应。 */
function harness(ready: Array<() => Response>) {
  const paths: string[] = [];
  const fetcher = (async (input: string) => {
    const path = new URL(input).pathname;
    paths.push(path);
    if (path === '/health') return Response.json({ ok: true });
    if (path === '/health/ready') return (ready.shift() ?? (() => Response.json({ ok: true, ready: true, pending: [] })))();
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const service = { mainPid: async () => 2002, restart: async () => undefined, stop: async () => undefined } as unknown as ServiceControl;
  let clock = 0;
  const deps = { fetch: fetcher, sleep: async (ms: number) => { clock += ms; }, now: () => clock };
  return { paths, service, deps, elapsed: () => clock };
}

const pending = () => Response.json({ ok: true, ready: false, pending: ['飞书长连接还在建立'] });

describe('waitForServiceHealth 就绪检查', () => {
  it('等到 /health/ready 报告就绪才算通过，飞书长连接还在建立时继续等', async () => {
    const h = harness([pending, pending]);
    expect(await waitForServiceHealth(h.service, 2001, 'http://127.0.0.1:4310', h.deps, 10_000)).toEqual({ ok: true, pid: 2002 });
    expect(h.paths.filter(path => path === '/health/ready')).toHaveLength(3);
    expect(h.elapsed()).toBe(2_000);
  });

  it('一直未就绪时超时失败，错误里带上未就绪原因', async () => {
    const h = harness(Array.from({ length: 20 }, () => pending));
    const result = await waitForServiceHealth(h.service, 2001, 'http://127.0.0.1:4310', h.deps, 3_000);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('飞书长连接还在建立');
  });

  it.each([
    ['旧版本没有该路由（404）', () => new Response('not found', { status: 404 })],
    ['旧版本回退到网页壳（200 + HTML）', () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })]
  ])('%s：按不支持放行，只看 /health', async (_name, response) => {
    const h = harness([response]);
    expect(await waitForServiceHealth(h.service, 2001, 'http://127.0.0.1:4310', h.deps, 10_000)).toEqual({ ok: true, pid: 2002 });
    expect(h.elapsed()).toBe(0);
  });

  it('/health/ready 返回 5xx 时继续等，不当作就绪', async () => {
    const h = harness([() => new Response('boom', { status: 503 })]);
    expect(await waitForServiceHealth(h.service, 2001, 'http://127.0.0.1:4310', h.deps, 10_000)).toEqual({ ok: true, pid: 2002 });
    expect(h.elapsed()).toBe(1_000);
  });
});
