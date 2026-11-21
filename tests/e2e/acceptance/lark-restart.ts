import { expect, type TestInfo } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchIsolatedTestServer, type TestServerInstance } from './harness';

const appId = 'cli_0000000000000001';
const messageId = 'om_restart';
const prompt = 'Summarize the restart test';
const chatId = 'oc_restart';

async function syntheticLark() {
  // The SDK registers the Feishu frame codec in its own protobufjs dependency.
  const sdkRequire = createRequire(require.resolve('@larksuiteoapi/node-sdk'));
  require('@larksuiteoapi/node-sdk');
  const frame = sdkRequire('protobufjs/minimal').roots.default.pbbp2.Frame;
  const { WebSocketServer } = sdkRequire('ws');
  const cards: { id: string; target?: string; content: any }[] = [];
  const reactions: { target: string; emoji: string }[] = [];
  let base: string;
  const http = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
    catch { res.destroy(); return; }
    let payload: unknown = { code: 0, data: {} };
    if (path === '/callback/ws/endpoint') {
      payload = { code: 0, data: { URL: base.replace('http:', 'ws:') + '/?device_id=1&service_id=1',
        ClientConfig: { PingInterval: 60, ReconnectCount: 0, ReconnectInterval: 1, ReconnectNonce: 0 } } };
    } else if (path === '/open-apis/auth/v3/tenant_access_token/internal/') {
      payload = { code: 0, tenant_access_token: 'synthetic', expire: 7200 };
    } else if (path === '/open-apis/bot/v3/info') {
      payload = { code: 0, bot: { open_id: 'ou_bot' } };
    } else if (path.endsWith('/members/list')) {
      payload = { code: 0, data: { items: [{ member_id: 'ou_requester', member_id_type: 'open_id' }], has_more: false } };
    } else if (path.endsWith('/' + chatId)) {
      payload = { code: 0, data: { chat_mode: 'group', name: 'Test group' } };
    } else if (req.method === 'POST' && path.endsWith('/reactions')) {
      const target = path.split('/').at(-2)!;
      reactions.push({ target, emoji: body.reaction_type.emoji_type });
      payload = target === messageId ? { code: 0, data: { reaction_id: 'r_' + reactions.length } } : { code: 230001, msg: 'unknown message' };
    } else if (req.method === 'POST' && body.msg_type === 'interactive') {
      const id = 'om_card_' + (cards.length + 1);
      cards.push({ id, target: path.endsWith('/reply') ? path.split('/').at(-2) : undefined, content: JSON.parse(body.content) });
      payload = { code: 0, data: { message_id: id } };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  });
  const ws = new WebSocketServer({ server: http });
  let connections = 0;
  ws.on('connection', () => { connections++; });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  base = 'http://127.0.0.1:' + (http.address() as AddressInfo).port;
  return {
    base, cards, reactions,
    connections: () => connections,
    mention() {
      const event = { schema: '2.0', header: { event_id: 'ev_restart', event_type: 'im.message.receive_v1', app_id: appId },
        event: { sender: { sender_id: { open_id: 'ou_requester' }, sender_type: 'user' },
          message: { message_id: messageId, chat_id: chatId, chat_type: 'group', message_type: 'text',
            content: JSON.stringify({ text: '@_user_1 ' + prompt }), mentions: [{ key: '@_user_1', name: 'Test bot', id: { open_id: 'ou_bot' } }] } } };
      const headers = Object.entries({ type: 'event', message_id: 'ev_restart', sum: '1', seq: '0' }).map(([key, value]) => ({ key, value }));
      const [client] = ws.clients;
      client!.send(frame.encode({ SeqID: 1, LogID: 1, service: 1, method: 1, headers, payload: Buffer.from(JSON.stringify(event)) }).finish());
    },
    async close() {
      for (const client of ws.clients) client.terminate();
      ws.close();
      http.closeAllConnections();
      await new Promise<void>(done => http.close(() => done()));
    }
  };
}

export async function verifyLarkRestart(reactionOnly: boolean, info: TestInfo) {
  const { createRepositories } = await import('@dutydeck/storage');
  const platform = await syntheticLark();
  let server: TestServerInstance | undefined;
  let repos: ReturnType<typeof createRepositories> | undefined;
  try {
    server = await launchIsolatedTestServer({
      prefix: 'dd-lark-', listenLark: true,
      beforeLaunch: async ({ dataDir, sourceRepo }) => {
        repos = createRepositories(join(dataDir, 'dutydeck.db'), { newDatabaseAuthority: 'ledger_v1' });
        await repos.config.set('lark.bots', JSON.stringify([{
          appId, appSecret: 'synthetic', listening: true, name: 'Test bot',
          defaultAgentId: 'claude-code', workspace: sourceRepo, fullTrustConfirmed: true, riskControlMode: 'off',
          completionReactionOnly: reactionOnly, silentProgress: false, memoryEnabled: false, groupToolsEnabled: false,
          allowedUsers: [{ openId: 'ou_requester' }]
        }]));
        return { extraEnv: { LARK_OPEN_API_BASE_URL: platform.base, MOCK_CLAUDE_RELEASE_FILE: join(dataDir, 'release') } };
      }
    });
    const instance = server;
    const mapping = async () => JSON.parse((await repos!.channelMappings.get('lark-card:' + appId, messageId))?.extra ?? '{}');
    const execution = async () => repos!.execution.getTaskExecution((await mapping()).runtime_task_id ?? 'pending');
    await expect.poll(platform.connections).toBe(1);
    platform.mention();
    await expect.poll(async () => JSON.parse(await repos!.config.get(`lark.inbox.${appId}.${messageId}`) ?? '{}').state).toBe('accepted');
    await expect.poll(async () => (await execution())?.currentAttempt?.submission?.recovery?.kind).toBe('pty-jsonl-v1');
    const checkpoint = (await execution())!.currentAttempt!.submission!.recovery!;
    if (checkpoint.kind !== 'pty-jsonl-v1') throw new Error('Missing native input receipt');
    const submittedTurn = () => spawnSync('tmux', [
      '-S', instance.socket, 'list-sessions', '-F', '#{@dutydeck_turn_id}'
    ], { encoding: 'utf8' }).stdout.trim();
    await expect.poll(submittedTurn, { timeout: 60_000 }).toBe(checkpoint.turnId);
    const processCard = (await mapping()).card_message_id;
    expect(platform.cards).toHaveLength(1);
    expect(platform.cards[0]).toMatchObject({ id: processCard, content: { header: { template: 'blue' } } });
    expect((await execution())?.task.status).toBe('running');

    await instance.crashAndRestart();
    await expect.poll(platform.connections).toBe(2);
    writeFileSync(join(instance.dataDir, 'release'), '');
    await expect.poll(async () => (await mapping()).final_delivery_state, { timeout: 45_000 }).toBe(reactionOnly ? 'reaction' : 'delivered');
    expect(await mapping()).toMatchObject({ state: 'completed', progress_frozen: true });
    const assertDelivery = async () => {
      const results = platform.cards.filter(card => card.id !== processCard);
      expect(results).toHaveLength(reactionOnly ? 0 : 1);
      if (!reactionOnly) {
        expect(results[0]).toMatchObject({ id: (await mapping()).final_message_id, target: messageId });
        expect(results[0]!.content.header).toMatchObject({ template: 'green' });
        expect(JSON.stringify(results[0]!.content.header)).toContain('已完成');
        expect(JSON.stringify(results[0]!.content)).toContain('MOCK_REPLY');
      }
      expect(platform.reactions.filter(entry => entry.emoji === 'CheckMark')).toEqual([{ target: messageId, emoji: 'CheckMark' }]);
    };
    await assertDelivery();
    // Listener readiness follows its startup reconciliation. Force another scan of the settled row.
    await instance.crashAndRestart();
    await expect.poll(platform.connections).toBe(3);
    await assertDelivery();
    expect(await mapping()).toMatchObject({
      final_delivery_state: reactionOnly ? 'reaction' : 'delivered', state: 'completed', progress_frozen: true
    });
    expect((await execution())?.attempts).toHaveLength(1);
    const transcripts = join(instance.dataDir, 'claude', 'projects');
    const inputs = readdirSync(transcripts, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.jsonl'))
      .flatMap(file => readFileSync(join(transcripts, file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
      .filter(entry => entry.type === 'user');
    expect(inputs).toHaveLength(1);
    expect(inputs[0].message.content).toContain(prompt);
    await info.attach('delivery.json', { contentType: 'application/json', body: JSON.stringify({
      messageId, processCard, resultCards: platform.cards.filter(card => card.id !== processCard).map(card => card.id),
      completionReactions: platform.reactions.filter(entry => entry.emoji === 'CheckMark'), submissions: inputs.length,
      finalState: (await mapping()).final_delivery_state, listenerConnections: platform.connections()
    }) });
  } finally {
    if (server) await info.attach('server.log', { body: server.serverLog.join(''), contentType: 'text/plain' });
    repos?.close();
    try { await server?.cleanup(); } finally { await platform.close(); }
  }
}
