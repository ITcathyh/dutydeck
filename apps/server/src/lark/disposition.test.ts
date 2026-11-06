import { describe, it, expect } from 'vitest';
import { annotateDisposition, queryDispositions, dispositionReasons, dispositionSchema } from './disposition.js';
import type { ConfigRepository } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { vi } from 'vitest';
function fixture() {
  const rows = new Map<string, string>();
  const store = { get: async (key: string) => rows.get(key), set: async (key: string, value: string) => { rows.set(key, value); },
    list: async (prefix: string) => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key,value]) => ({key,value})),
    compareAndSet: async (key: string, old: string | undefined, value: string) => { if (rows.get(key) !== old) return false; rows.set(key,value); return true; }
  } as ConfigRepository;
  const record = { appId: 'app', state: 'ignored', boot: '', receivedAt: new Date().toISOString(), event: { messageId: 'om_1', chatId: 'oc_1', senderOpenId: 'ou_1', content: '你好' } };
  rows.set('lark.inbox.app.om_1', JSON.stringify(record));
  return {store, rows};
}
describe('message disposition', () => {
  it('records every stable reason and keeps old records readable', async () => {
    const {store} = fixture();
    expect((await queryDispositions(store, {messageId:'om_1'}))[0]?.detail).toBe('旧记录未记录原因');
    for (const reason of Object.keys(dispositionReasons) as Array<keyof typeof dispositionReasons>) {
      const {store} = fixture();
      await annotateDisposition(store, 'app','om_1',{schemaVersion:1,reason});
      expect((await queryDispositions(store, {messageId:'om_1'}))[0]?.reason).toBe(reason);
    }
    expect(dispositionSchema.safeParse({schemaVersion:1, reason:'not_addressed', extra:true}).success).toBe(false);
  });
  it('links merged messages and silent decisions without changing state', async () => {
    const {store} = fixture();
    await annotateDisposition(store,'app','om_1',{schemaVersion:1,reason:'participation_merged',mergedInto:'om_2'});
    expect((await queryDispositions(store,{chatId:'oc_1'}))[0]).toMatchObject({state:'ignored',mergedInto:'om_2'});
    await annotateDisposition(store,'app','om_1',{schemaVersion:1,reason:'participation_silent',decisionId:'decision_1'});
    expect((await queryDispositions(store,{messageId:'om_1'}))[0]?.decisionId).toBe('decision_1');
    expect(await queryDispositions(store,{chatId:'other'})).toEqual([]);
    await expect(queryDispositions(store,{since:'1y'})).rejects.toThrow();
  });
});

it('does not overwrite a final decision with the intake waiting reason', async () => {
 const {store} = fixture();
 await annotateDisposition(store,'app','om_1',{schemaVersion:1,reason:'participation_silent',decisionId:'d_1',detail:'无需回复'});
 await annotateDisposition(store,'app','om_1',{schemaVersion:1,reason:'participation_observes'});
 expect((await queryDispositions(store,{messageId:'om_1'}))[0]).toMatchObject({reason:'participation_silent',decisionId:'d_1',detail:'无需回复'});
 await annotateDisposition(store,'app','om_1',{schemaVersion:1,reason:'participation_replied',decisionId:'d_1'});
 expect(await queryDispositions(store,{chatId:'oc_1'})).toEqual([]);
 expect((await queryDispositions(store,{messageId:'om_1'}))[0]?.reason).toBe('participation_replied');
});

it('lists dispositions from projected fields and reads bodies only for shown rows without a snippet', async () => {
  const repos = createRepositories(':memory:');
  try {
    const at = (index: number) => new Date(Date.now() - index * 1_000).toISOString();
    const content = JSON.stringify({ elements: 'x'.repeat(15_000) });
    expect(await repos.config.compareAndSetBatch!([], Array.from({ length: 3_000 }, (_, index) => ({ key: `lark.inbox.app.om_${index}`,
      value: JSON.stringify({ appId: 'app', state: 'ignored', boot: '', receivedAt: at(index), reason: 'bot_message',
        event: { messageId: `om_${index}`, chatId: 'oc_1', senderType: 'bot', content: index < 2 ? content : '' }, ...(index < 2 ? {} : { snippet: `摘要 ${index}` }) }) })))).toBe(true);
    await repos.config.set('lark.inbox.app.om_text', JSON.stringify({ appId: 'app', state: 'failed', boot: '', receivedAt: at(0.5), event: { messageId: 'om_text', chatId: 'oc_1', senderOpenId: 'ou_1', content: '{"text":"真人原文"}' } }));
    const list = vi.spyOn(repos.config, 'list');
    const get = vi.spyOn(repos.config, 'get');
    const result = await queryDispositions(repos.config, { appId: 'app', since: '30d' });
    expect(result).toHaveLength(500);
    expect(result.slice(0, 4)).toEqual([
      expect.objectContaining({ messageId: 'om_0', snippet: content.slice(0, 160), sender: 'bot', reason: 'bot_message', detail: dispositionReasons.bot_message }),
      expect.objectContaining({ messageId: 'om_text', state: 'failed', snippet: '真人原文', sender: 'ou_1' }),
      expect.objectContaining({ messageId: 'om_1', snippet: content.slice(0, 160) }),
      expect.objectContaining({ messageId: 'om_2', snippet: '摘要 2' })]);
    expect(list).not.toHaveBeenCalled();
    expect(get.mock.calls.map(([key]) => key).sort()).toEqual(['lark.inbox.app.om_0', 'lark.inbox.app.om_1', 'lark.inbox.app.om_text']);
  } finally { repos.close(); }
});
