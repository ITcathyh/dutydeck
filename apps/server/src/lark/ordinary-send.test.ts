import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { sendOrdinaryMessage } from './ordinary-send.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
function database() {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-ordinary-send-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'state.db');
  const open = () => { const repositories = createRepositories(path); cleanup.push(() => repositories.close()); return repositories; };
  return { open };
}
function intent(send = vi.fn(async () => ({ messageId: 'om_receipt', chatId: 'oc_chat' }))) {
  return { scope: JSON.stringify({ appId: 'cli_app', sessionId: 'ses_one', chatId: 'oc_chat' }),
    idempotencyKey: 'intent-one', payload: { text: 'hello', replyTo: '', inThread: false },
    beforeSend: vi.fn(async () => {}), beforeReceipt: vi.fn(async () => {}), send };
}

describe('durable ordinary send receipts', () => {
  it('returns the committed receipt after reopening SQLite, even much later', async () => {
    const db = database(); const first = db.open(); const input = intent();
    expect(await sendOrdinaryMessage(first.config, input)).toEqual({ messageId: 'om_receipt', chatId: 'oc_chat' });
    first.close();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 365 * 24 * 60 * 60_000);
    expect(await sendOrdinaryMessage(db.open().config, input)).toEqual({ messageId: 'om_receipt', chatId: 'oc_chat' });
    expect(input.send).toHaveBeenCalledTimes(1); expect(input.beforeReceipt).toHaveBeenCalledTimes(1);
  });

  it('never retries after the platform sent but its response was lost', async () => {
    const db = database(); const first = db.open(); let platformMessages = 0;
    const send = vi.fn(async () => { platformMessages += 1; throw new Error('connection lost after send'); });
    const input = intent(send);
    await expect(sendOrdinaryMessage(first.config, input)).rejects.toMatchObject({ code: 'GROUP_SEND_RESULT_UNKNOWN' });
    first.close();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 365 * 24 * 60 * 60_000);
    await expect(sendOrdinaryMessage(db.open().config, input)).rejects.toMatchObject({ code: 'GROUP_SEND_RESULT_UNKNOWN' });
    expect(platformMessages).toBe(1);
  });

  it('admits one sender across independent repositories of the same SQLite database', async () => {
    const db = database(); const left = db.open(); const right = db.open(); const input = intent();
    const results = await Promise.allSettled([sendOrdinaryMessage(left.config, input), sendOrdinaryMessage(right.config, input)]);
    expect(input.send).toHaveBeenCalledTimes(1);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    expect(await sendOrdinaryMessage(right.config, input)).toEqual({ messageId: 'om_receipt', chatId: 'oc_chat' });
  });

  it('does not send without durable CAS', async () => {
    const db = database().open(); const input = intent();
    await expect(sendOrdinaryMessage({ get: db.config.get, set: db.config.set }, input)).rejects.toMatchObject({ code: 'GROUP_SEND_STORAGE_UNAVAILABLE' });
    expect(input.send).not.toHaveBeenCalled();
  });

  it.each(['before', 'after'] as const)('can retry an intent whose pending write failed %s commit before any attempt', async failure => {
    const db = database().open(); const input = intent(); const cas = db.config.compareAndSet!.bind(db.config);
    vi.spyOn(db.config, 'compareAndSet').mockImplementationOnce(async (key, expected, value) => {
      if (failure === 'after') await cas(key, expected, value);
      throw new Error('pending write failed');
    });
    await expect(sendOrdinaryMessage(db.config, input)).rejects.toThrow('pending write failed');
    expect(input.send).not.toHaveBeenCalled();
    expect(await sendOrdinaryMessage(db.config, input)).toMatchObject({ messageId: 'om_receipt' });
    expect(input.send).toHaveBeenCalledTimes(1);
  });

  it.each(['before', 'after'] as const)('fails closed when the first-attempt write fails %s SQLite commit', async failure => {
    const db = database().open(); const input = intent(); const cas = db.config.compareAndSet!.bind(db.config);
    vi.spyOn(db.config, 'compareAndSet').mockImplementation(async (key, expected, value) => {
      if (JSON.parse(value).firstAttemptAt !== undefined) {
        if (failure === 'after') await cas(key, expected, value);
        throw new Error('first-attempt write failed');
      }
      return cas(key, expected, value);
    });
    await expect(sendOrdinaryMessage(db.config, input)).rejects.toThrow('first-attempt write failed');
    expect(input.send).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    if (failure === 'after') await expect(sendOrdinaryMessage(db.config, input)).rejects.toMatchObject({ code: 'GROUP_SEND_RESULT_UNKNOWN' });
    else expect(await sendOrdinaryMessage(db.config, input)).toMatchObject({ messageId: 'om_receipt' });
    expect(input.send).toHaveBeenCalledTimes(failure === 'after' ? 0 : 1);
  });

  it.each(['before', 'after'] as const)('reconciles a receipt write failing %s SQLite commit', async failure => {
    const db = database(); const first = db.open(); const input = intent(); const cas = first.config.compareAndSet!.bind(first.config);
    vi.spyOn(first.config, 'compareAndSet').mockImplementation(async (key, expected, value) => {
      if (JSON.parse(value).status === 'sent') {
        if (failure === 'after') await cas(key, expected, value);
        throw new Error('receipt write failed');
      }
      return cas(key, expected, value);
    });
    if (failure === 'after') expect(await sendOrdinaryMessage(first.config, input)).toMatchObject({ messageId: 'om_receipt' });
    else await expect(sendOrdinaryMessage(first.config, input)).rejects.toMatchObject({ code: 'GROUP_SEND_RESULT_UNKNOWN' });
    first.close(); const restarted = db.open();
    if (failure === 'after') expect(await sendOrdinaryMessage(restarted.config, input)).toMatchObject({ messageId: 'om_receipt' });
    else await expect(sendOrdinaryMessage(restarted.config, input)).rejects.toMatchObject({ code: 'GROUP_SEND_RESULT_UNKNOWN' });
    expect(input.send).toHaveBeenCalledTimes(1);
  });

  it('allows an unstarted pending intent to be claimed after process exit', async () => {
    const db = database(); const first = db.open(); const input = intent();
    input.beforeSend.mockRejectedValueOnce(new Error('process exited before claim'));
    await expect(sendOrdinaryMessage(first.config, input)).rejects.toThrow('process exited before claim');
    first.close();
    expect(await sendOrdinaryMessage(db.open().config, input)).toMatchObject({ messageId: 'om_receipt' });
    expect(input.send).toHaveBeenCalledTimes(1);
  });

  it('keeps the attempted record when even the post-send authoritative read fails', async () => {
    const db = database().open(); const input = intent(); const get = db.config.get.bind(db.config);
    input.send.mockImplementation(async () => { vi.spyOn(db.config, 'get').mockRejectedValue(new Error('read unavailable')); throw new Error('response lost'); });
    await expect(sendOrdinaryMessage(db.config, input)).rejects.toMatchObject({ code: 'GROUP_SEND_RESULT_UNKNOWN' });
    vi.mocked(db.config.get).mockImplementation(get);
    await expect(sendOrdinaryMessage(db.config, input)).rejects.toMatchObject({ code: 'GROUP_SEND_RESULT_UNKNOWN' });
    expect(input.send).toHaveBeenCalledTimes(1);
  });

  it('rejects payload changes without changing the original scope/key record', async () => {
    const db = database().open(); const input = intent(); await sendOrdinaryMessage(db.config, input);
    for (const payload of [{ text: 'changed' }, { text: 'hello', replyTo: 'om_elsewhere', inThread: false }, { text: 'hello', replyTo: '', inThread: true }]) {
      await expect(sendOrdinaryMessage(db.config, { ...input, payload })).rejects.toMatchObject({ code: 'GROUP_SEND_CONTENT_CONFLICT' });
    }
    expect(input.send).toHaveBeenCalledTimes(1);
  });
});
