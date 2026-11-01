import { describe, it, expect } from 'vitest';
import { annotateDisposition, queryDispositions, dispositionReasons, dispositionSchema } from './disposition.js';
import type { ConfigRepository } from '@dutydeck/shared';
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
