import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { StoredLarkConfig } from '@dutydeck/shared';
import { LarkLongConnectionListener } from '../lark/listener.js';
import type { LarkSmokeEvent } from './lark-smoke.js';

const SMOKE_PATH = '/dutydeck-setup-smoke';

/** Reuse the real listener without a coordinator: forwarded events stop at this loopback receiver. */
export async function startLarkSmokeListener(
  bot: StoredLarkConfig,
  onEvent: (event: LarkSmokeEvent) => void
): Promise<() => Promise<void>> {
  const token = randomUUID();
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== SMOKE_PATH) {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 1_048_576) {
          request.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      let envelope: any;
      try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { request.destroy(); return; }
      const event = envelope?.event;
      const eventId = event?.event_id;
      if (envelope?.app_id !== bot.appId || envelope?.handler_id !== 'setup_smoke' || typeof eventId !== 'string') {
        response.writeHead(400).end();
        return;
      }
      onEvent({
        eventId,
        messageId: event.message?.message_id,
        chatId: event.message?.chat_id,
        chatType: event.message?.chat_type,
        parentId: event.message?.parent_id,
        rootId: event.message?.root_id,
        content: event.message?.content,
        senderOpenId: event.sender?.sender_id?.open_id,
        senderType: event.sender?.sender_type
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ event_id: eventId, decision: 'stop' }));
    })().catch(() => { request.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('No loopback address for the setup smoke receiver');
  }
  const closeServer = async () => {
    if (!server.listening) return;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  };
  const log = { info() {}, warn() {}, error() {} };
  const listener = new LarkLongConnectionListener(log, { forceCloseOnStop: true });
  try {
    await listener.start({
      ...bot,
      welcomeEnabled: false,
      cardActionForwarding: undefined,
      eventHandlers: [{ id: 'setup_smoke', eventTypes: ['im.message.receive_v1'], url: `http://127.0.0.1:${address.port}${SMOKE_PATH}`, token }]
    });
  } catch (error) {
    try { await listener.stop({ force: true }); }
    finally { await closeServer(); }
    throw error;
  }
  return async () => {
    try { await listener.stop({ force: true }); }
    finally { await closeServer(); }
  };
}
