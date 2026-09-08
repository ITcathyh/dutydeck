import { describe, expect, it, vi } from 'vitest';
import { RelayAskBroker } from './ask-broker.js';
import type { RelayAskRecord, RelayAskStore, RelayPublishInput } from './types.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

const drainMicrotasks = async (count = 5) => {
  for (let index = 0; index < count; index++) await Promise.resolve();
};

const relayRecord = (overrides: Partial<RelayAskRecord> = {}): RelayAskRecord => ({
  id: 'ask_recovery',
  sessionId: 'ses_one',
  question: '继续吗？',
  status: 'pending',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...overrides
});

describe('relay answer races', () => {
  it('publishes only the first concurrent answer and does not let stop overwrite it', async () => {
    const gate = deferred();
    const events: RelayPublishInput[] = [];
    const broker = new RelayAskBroker({ publish: async (_session, input) => {
      events.push(input);
      if (input.kind === 'answer') await gate.promise;
    } });
    const waiting = broker.register({ sessionId: 'ses_one', question: 'A or B?' });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    const id = broker.listPending()[0]!.id;
    const first = broker.answer(id, 'A');
    await vi.waitFor(() => expect(events.filter(event => event.kind === 'answer')).toHaveLength(1));
    await expect(broker.answer(id, 'B')).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
    broker.cancelSession('ses_one');
    broker.close();
    gate.resolve();
    await expect(first).resolves.toMatchObject({ status: 'answered', answer: 'A' });
    await expect(waiting).resolves.toMatchObject({ status: 'answered', answer: 'A' });
    expect(events.filter(event => event.kind === 'answer')).toEqual([{ kind: 'answer', text: 'A', askId: id }]);
  });

  it('can answer immediately from the question publisher', async () => {
    let broker!: RelayAskBroker;
    broker = new RelayAskBroker({ publish: async (_session, input) => {
      if (input.kind === 'ask') await broker.answer(input.askId!, '收到');
    } });
    await expect(broker.register({ sessionId: 'ses_one', question: '在吗？' })).resolves.toMatchObject({ status: 'answered', answer: '收到' });
  });

  it('cancels the waiter when publishing the winning answer fails', async () => {
    const broker = new RelayAskBroker({ publish: async (_session, input) => {
      if (input.kind === 'answer') throw new Error('event storage unavailable');
    } });
    const waiting = broker.register({ sessionId: 'ses_one', question: 'Proceed?' });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    const id = broker.listPending()[0]!.id;
    await expect(broker.answer(id, 'yes')).rejects.toThrow('event storage unavailable');
    await expect(waiting).resolves.toMatchObject({ status: 'cancelled' });
    await expect(broker.answer(id, 'again')).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
  });

  it('expires a pending question when its timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const broker = new RelayAskBroker({ publish: async () => undefined });
      const waiting = broker.register({ sessionId: 'ses_one', question: '稍后回答？', timeoutMs: 1_000 });
      await drainMicrotasks();
      expect(broker.listPending()).toHaveLength(1);
      vi.advanceTimersByTime(1_000);
      await expect(waiting).resolves.toMatchObject({ status: 'expired' });
      expect(broker.listPending()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the claimed answer as the first win when the timeout deadline passes', async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred();
      const events: RelayPublishInput[] = [];
      const broker = new RelayAskBroker({ publish: async (_session, input) => {
        events.push(input);
        if (input.kind === 'answer') await gate.promise;
      } });
      const waiting = broker.register({ sessionId: 'ses_one', question: '采用哪个？', timeoutMs: 1_000 });
      await drainMicrotasks();
      const id = broker.listPending()[0]!.id;
      const answer = broker.answer(id, 'A');
      await drainMicrotasks();
      vi.advanceTimersByTime(1_000);
      gate.resolve();
      await expect(answer).resolves.toMatchObject({ status: 'answered', answer: 'A' });
      await expect(waiting).resolves.toMatchObject({ status: 'answered', answer: 'A' });
      expect(events.filter(event => event.kind === 'answer')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases register and flush when the question publisher never settles', async () => {
    const never = new Promise<void>(() => undefined);
    const broker = new RelayAskBroker({ publish: async () => never });
    const waiting = broker.register({ sessionId: 'ses_one', question: '发布会完成吗？' });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    broker.close('shutdown');
    await expect(waiting).resolves.toMatchObject({ status: 'cancelled', reason: 'shutdown' });
    await expect(broker.flush()).resolves.toBeUndefined();
    expect(broker.listPending()).toEqual([]);
  });

  it('releases an answering request after close when the answer publisher never settles', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => undefined);
      let answerStarted = false;
      const broker = new RelayAskBroker({ publish: async (_session, input) => {
        if (input.kind === 'answer') answerStarted = true;
        if (input.kind === 'answer') await never;
      } });
      const waiting = broker.register({ sessionId: 'ses_one', question: '是否发送？' });
      await drainMicrotasks();
      const id = broker.listPending()[0]!.id;
      const answer = broker.answer(id, '发送');
      await drainMicrotasks();
      expect(answerStarted).toBe(true);
      broker.close('shutdown');
      vi.advanceTimersByTime(1_000);
      await expect(answer).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
      await expect(waiting).resolves.toMatchObject({ status: 'cancelled', reason: 'shutdown' });
      await expect(broker.flush()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['close', (broker: RelayAskBroker) => broker.close('shutdown')],
    ['cancel', (broker: RelayAskBroker) => broker.cancelSession('ses_one', 'cancelled by session')]
  ])('does not publish after %s while the claim CAS is awaiting', async (_action, stop) => {
    const gate = deferred();
    const events: RelayPublishInput[] = [];
    let claimStarted = false;
    let persisted: RelayAskRecord | undefined;
    const store: RelayAskStore = {
      list: async () => [],
      get: async () => persisted,
      compareAndSet: async (expected, next) => {
        if (!expected) {
          persisted = next;
          return true;
        }
        if (next.status === 'answering') {
          claimStarted = true;
          await gate.promise;
        }
        persisted = next;
        return true;
      }
    };
    const broker = new RelayAskBroker({ publish: async (_session, input) => { events.push(input); } }, store);
    const waiting = broker.register({ sessionId: 'ses_one', question: '可以继续吗？' });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    const id = broker.listPending()[0]!.id;
    const answer = broker.answer(id, '继续');
    await vi.waitFor(() => expect(claimStarted).toBe(true));
    stop(broker);
    gate.resolve();
    await expect(answer).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
    await expect(waiting).resolves.toMatchObject({ status: 'cancelled' });
    expect(events.filter(event => event.kind === 'answer')).toEqual([]);
    expect(broker.listPending()).toEqual([]);
    await expect(broker.flush()).resolves.toBeUndefined();
  });

  it('uses the terminal record after a terminal CAS loses instead of reporting its own outcome', async () => {
    let persisted: RelayAskRecord | undefined;
    let terminal: RelayAskRecord | undefined;
    const store: RelayAskStore = {
      list: async () => [],
      get: async () => terminal ?? persisted,
      compareAndSet: async (expected, next) => {
        if (!expected) {
          persisted = next;
          return true;
        }
        terminal = { ...next, status: 'answered', answer: '来自另一个回答者' };
        return false;
      }
    };
    const broker = new RelayAskBroker({ publish: async () => undefined }, store);
    const waiting = broker.register({ sessionId: 'ses_one', question: '采用哪个？' });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    const id = broker.listPending()[0]!.id;
    broker.cancelSession('ses_one');
    await expect(waiting).resolves.toMatchObject({ status: 'answered', answer: '来自另一个回答者' });
    expect(broker.get(id)).toMatchObject({ status: 'answered', answer: '来自另一个回答者' });
    await expect(broker.flush()).resolves.toBeUndefined();
  });

  it('cleans pending state and reports a terminal CAS error through flush', async () => {
    const writeError = new Error('terminal write failed');
    let persisted: RelayAskRecord | undefined;
    const store: RelayAskStore = {
      list: async () => [],
      get: async () => persisted,
      compareAndSet: async (expected, next) => {
        if (!expected) {
          persisted = next;
          return true;
        }
        throw writeError;
      }
    };
    const broker = new RelayAskBroker({ publish: async () => undefined }, store);
    const waiting = broker.register({ sessionId: 'ses_one', question: '写入会成功吗？' });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    const id = broker.listPending()[0]!.id;
    broker.cancelSession('ses_one');
    await expect(waiting).rejects.toBe(writeError);
    expect(broker.listPending()).toEqual([]);
    expect(broker.get(id)).toBeUndefined();
    await expect(broker.flush()).rejects.toMatchObject({ name: 'AggregateError' });
    await expect(broker.flush()).resolves.toBeUndefined();
  });

  it('re-reads after a recovery CAS conflict and keeps the authoritative terminal record', async () => {
    const initial = relayRecord();
    const terminal = relayRecord({ status: 'cancelled', reason: '已由另一实例收敛' });
    let compareCalls = 0;
    let getCalls = 0;
    const store: RelayAskStore = {
      list: async () => [initial],
      get: async () => { getCalls += 1; return terminal; },
      compareAndSet: async () => { compareCalls += 1; return false; }
    };
    const broker = new RelayAskBroker({ publish: async () => undefined }, store);
    await expect(broker.initialize()).resolves.toBeUndefined();
    expect(compareCalls).toBe(1);
    expect(getCalls).toBe(1);
    expect(broker.get(initial.id)).toMatchObject({ status: 'cancelled', reason: '已由另一实例收敛' });
  });

  it('fails recovery after bounded CAS conflicts instead of silently accepting a live record', async () => {
    const initial = relayRecord();
    let compareCalls = 0;
    let getCalls = 0;
    const store: RelayAskStore = {
      list: async () => [initial],
      get: async () => { getCalls += 1; return initial; },
      compareAndSet: async () => { compareCalls += 1; return false; }
    };
    const broker = new RelayAskBroker({ publish: async () => undefined }, store);
    await expect(broker.initialize()).rejects.toMatchObject({ code: 'RELAY_RECOVERY_CONFLICT' });
    expect(compareCalls).toBe(3);
    expect(getCalls).toBe(3);
  });
});
