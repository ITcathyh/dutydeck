import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { openSseStream } from '../scripts/smoke-sse.mjs';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const frame = (sequence: number, type: string) => `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify({ sequence, type, data: { outcome: 'completed' } })}\n\n`;

it('keeps the second completed event when a heartbeat precedes it in the same HTTP chunk', async () => {
  let finishSecondTurn!: () => void;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': connected\n\n' + frame(1, 'completed'));
    finishSecondTurn = () => response.write(': heartbeat\n\nevent: text\ndata:\n\nevent: heartbeat\ndata: {"ts":1792634535876}\n\n' + frame(2, 'text') + frame(3, 'status') + frame(4, 'completed'));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const debug = vi.fn();
  const stream = openSseStream(`http://127.0.0.1:${address.port}/stream`, debug);
  try {
    expect((await stream.done).map((item: any) => item.event.sequence)).toEqual([1]);
    const beforeResume = stream.cursor(); finishSecondTurn();
    await vi.waitFor(() => expect(stream.since(beforeResume).map((item: any) => item.event.sequence)).toEqual([2, 3, 4]));
    expect(stream.events.map((item: any) => item.type)).toEqual(['completed', 'text', 'status', 'completed']);
    expect(stream.cursor()).toBe(4); expect(debug).toHaveBeenCalledTimes(4);
  } finally { stream.close(); }
});

it('reports a connection ending before its first completed event', async () => {
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('event: heartbeat\ndata: {"ts":1}\n\n'); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const stream = openSseStream(`http://127.0.0.1:${address.port}/stream`);
  try { await expect(stream.done).rejects.toThrow('SSE 流在收到 completed 前结束'); expect(stream.events).toEqual([]); }
  finally { stream.close(); }
});
