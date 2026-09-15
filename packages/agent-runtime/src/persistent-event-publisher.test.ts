import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentEvent } from '@dutydeck/shared';
import { PersistentEventPublisher } from './persistent-event-publisher.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('../../storage/node_modules/better-sqlite3');

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createTestDb() {
  const tmpDir = await mkdtemp(join(tmpdir(), 'dutydeck-pub-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const repos = createRepositories(dbPath);
  const readonlySqlite = new Database(dbPath, { readonly: true });
  const hwmStmt = readonlySqlite.prepare(
    'SELECT COALESCE(MAX(sequence), 0) AS hwm FROM events WHERE session_id = ?'
  );

  const source = {
    highWaterMark(sessionId: string): number {
      const row = hwmStmt.get(sessionId) as { hwm: number };
      return row?.hwm ?? 0;
    },
    listWindow(
      sessionId: string,
      options: { afterSequence: number; limit: number }
    ): Promise<AgentEvent[]> {
      return repos.events.listWindow(sessionId, options);
    }
  };

  return {
    tmpDir,
    dbPath,
    repos,
    readonlySqlite,
    source,
    async cleanup() {
      try {
        readonlySqlite.close();
      } catch {}
      try {
        repos.close();
      } catch {}
      await rm(tmpDir, { recursive: true, force: true });
    }
  };
}

async function appendTestEvent(
  repos: any,
  sessionId: string,
  sequence: number,
  data: any = { seq: sequence }
) {
  await repos.events.append({
    id: `evt_${sessionId}_${sequence}`,
    sessionId,
    sequence,
    type: 'text',
    timestamp: new Date().toISOString(),
    data
  });
}

describe('PersistentEventPublisher', () => {
  it('注册默认水位不重发历史且捕获注册后提交', async () => {
    const db = await createTestDb();
    try {
      const sessionId = 'ses_default_hwm';
      await appendTestEvent(db.repos, sessionId, 1);
      await appendTestEvent(db.repos, sessionId, 2);

      const publisher = new PersistentEventPublisher(db.source);
      const received: AgentEvent[] = [];
      const cancel = publisher.subscribe(sessionId, (evt) => {
        received.push(evt);
      });

      // 验证历史事件没有被发送
      await vi.waitFor(() => {
        expect(received.length).toBe(0);
      });

      // 提交新事件
      await appendTestEvent(db.repos, sessionId, 3);
      publisher.wake(sessionId);

      await vi.waitFor(() => {
        expect(received.length).toBe(1);
      });
      expect(received[0].sequence).toBe(3);

      cancel();
      await publisher.close();
    } finally {
      await db.cleanup();
    }
  });

  it('显式 cursor 多页补发顺序', async () => {
    const db = await createTestDb();
    try {
      const sessionId = 'ses_multi_page';
      const totalEvents = 450;
      for (let i = 1; i <= totalEvents; i++) {
        await appendTestEvent(db.repos, sessionId, i, { index: i });
      }

      const publisher = new PersistentEventPublisher(db.source);
      const received: AgentEvent[] = [];
      const done = deferred();

      publisher.subscribe(
        sessionId,
        (evt) => {
          received.push(evt);
          if (received.length === totalEvents) {
            done.resolve();
          }
        },
        { afterSequence: 0 }
      );

      await done.promise;
      expect(received.length).toBe(totalEvents);
      for (let i = 0; i < totalEvents; i++) {
        expect(received[i].sequence).toBe(i + 1);
      }

      await publisher.close();
    } finally {
      await db.cleanup();
    }
  });

  it('持久化成功但完全不 wake 时存活进程自动补查', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const db = await createTestDb();
    try {
      const sessionId = 'ses_auto_poll';
      const publisher = new PersistentEventPublisher(db.source);
      const received: AgentEvent[] = [];

      publisher.subscribe(sessionId, (evt) => {
        received.push(evt);
      });

      // 写入新事件，但完全不调用 publisher.wake
      await appendTestEvent(db.repos, sessionId, 1);
      expect(received.length).toBe(0);

      // 推进 1000ms 补查定时器
      await vi.advanceTimersByTimeAsync(1000);

      expect(received.length).toBe(1);
      expect(received[0].sequence).toBe(1);

      await publisher.close();
    } finally {
      vi.useRealTimers();
      await db.cleanup();
    }
  });

  it('查询失败完全不再 wake/append/reconnect 仅定时补查恢复', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const db = await createTestDb();
    try {
      const sessionId = 'ses_query_failure_timer_recovery';
      await appendTestEvent(db.repos, sessionId, 1);

      let queries = 0;
      const reportedErrors: any[] = [];
      const wrappedSource = {
        highWaterMark: db.source.highWaterMark,
        async listWindow(sid: string, opts: any) {
          queries++;
          if (queries === 1) {
            throw new Error('Simulated transient query error');
          }
          return db.source.listWindow(sid, opts);
        }
      };

      const publisher = new PersistentEventPublisher(
        wrappedSource,
        (err, sid) => {
          reportedErrors.push({ err, sid });
        }
      );

      const received: AgentEvent[] = [];
      publisher.subscribe(
        sessionId,
        (evt) => {
          received.push(evt);
        },
        { afterSequence: 0 }
      );

      // 首次查询在后台启动并失败
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 20));
      expect(reportedErrors.length).toBe(1);
      expect(received.length).toBe(0);

      // 完全不调用 wake，不 append 新事件，不重新连接，仅推进 1000ms 补查定时器
      await vi.advanceTimersByTimeAsync(1000);

      expect(received.length).toBe(1);
      expect(received[0].sequence).toBe(1);

      await publisher.close();
    } finally {
      vi.useRealTimers();
      await db.cleanup();
    }
  });

  it('async listener reject 独立重试且其他 listener 仅成功一次，async onError reject 无 unhandled', async () => {
    const db = await createTestDb();
    const unhandledList: any[] = [];
    const onUnhandled = (e: any) => unhandledList.push(e);
    process.on('unhandledRejection', onUnhandled);

    try {
      const sessionId = 'ses_async_reject_isolation';
      await appendTestEvent(db.repos, sessionId, 1);

      let aCalls = 0;
      let bCalls = 0;
      let onErrorCalls = 0;

      const publisher = new PersistentEventPublisher(
        db.source,
        async () => {
          onErrorCalls++;
          // async onError 抛错或 reject，验证绝不产生 unhandledRejection
          throw new Error('async onError rejected');
        }
      );

      publisher.subscribe(
        sessionId,
        async (evt) => {
          aCalls++;
          if (aCalls === 1) {
            throw new Error('async callback rejected');
          }
        },
        { afterSequence: 0 }
      );

      publisher.subscribe(
        sessionId,
        async (evt) => {
          bCalls++;
        },
        { afterSequence: 0 }
      );

      // 首次交付：B 成功，A 失败，onError 被调用
      await vi.waitFor(() => {
        expect(bCalls).toBe(1);
        expect(aCalls).toBe(1);
        expect(onErrorCalls).toBe(1);
      });

      // 再次 wake，重试失败的 A
      publisher.wake(sessionId);

      await vi.waitFor(() => {
        expect(aCalls).toBe(2);
        // B 游标已推进，绝不重复调用
        expect(bCalls).toBe(1);
      });

      // 验证全程零 unhandledRejection
      expect(unhandledList.length).toBe(0);

      await publisher.close();
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await db.cleanup();
    }
  });

  it('旧 async callback 挂起期间取消并替换，close 仍等待旧 callback 且不污染新游标', async () => {
    const db = await createTestDb();
    try {
      const sessionId = 'ses_replace_and_close_wait';
      await appendTestEvent(db.repos, sessionId, 1);
      await appendTestEvent(db.repos, sessionId, 2);

      const oldGate = deferred();
      const oldReceived: number[] = [];
      const newReceived: number[] = [];

      const publisher = new PersistentEventPublisher(db.source);

      // 注册旧订阅并在事件 1 挂起
      const cancelOld = publisher.subscribe(
        sessionId,
        async (evt) => {
          oldReceived.push(evt.sequence);
          await oldGate.promise;
        },
        { afterSequence: 0 }
      );

      await vi.waitFor(() => {
        expect(oldReceived).toEqual([1]);
      });

      // 取消旧订阅并建立新订阅
      cancelOld();
      publisher.subscribe(
        sessionId,
        (evt) => {
          newReceived.push(evt.sequence);
        },
        { afterSequence: 0 }
      );

      await vi.waitFor(() => {
        expect(newReceived).toEqual([1, 2]);
      });

      // 触发 close
      let closeSettled = false;
      const closePromise = publisher.close().then(() => {
        closeSettled = true;
      });

      // 等待宏任务，验证在 oldGate 未释放前 close 必须保持 pending
      await new Promise((r) => setTimeout(r, 40));
      expect(closeSettled).toBe(false);

      // 释放旧回调
      oldGate.resolve();
      await closePromise;
      expect(closeSettled).toBe(true);

      // 验证旧回调没有再收到事件 2，新回调完整收到 [1, 2]
      expect(oldReceived).toEqual([1]);
      expect(newReceived).toEqual([1, 2]);
    } finally {
      await db.cleanup();
    }
  });

  it('常规外部 close 在 source query 已进入并等待 deferred 时保持 pending 且压制回调', async () => {
    const db = await createTestDb();
    try {
      const sessionId = 'ses_external_close_query';
      await appendTestEvent(db.repos, sessionId, 1);

      const qgate = deferred();
      let qentered = false;
      let callbackCalls = 0;

      const wrappedSource = {
        highWaterMark: db.source.highWaterMark,
        async listWindow(s: string, o: any) {
          qentered = true;
          await qgate.promise;
          return db.source.listWindow(s, o);
        }
      };

      const publisher = new PersistentEventPublisher(wrappedSource);
      publisher.subscribe(
        sessionId,
        () => {
          callbackCalls++;
        },
        { afterSequence: 0 }
      );

      // listWindow 必须已经被同步进入
      expect(qentered).toBe(true);

      let qclosed = false;
      const closePromise = publisher.close().then(() => {
        qclosed = true;
      });

      await new Promise((r) => setTimeout(r, 40));
      expect(qclosed).toBe(false);

      // 释放 query
      qgate.resolve();
      await closePromise;
      expect(qclosed).toBe(true);
      expect(callbackCalls).toBe(0);
    } finally {
      await db.cleanup();
    }
  });

  it('反例A: source.listWindow 同步发起 close 时，close 必须等待在途 query 完成', async () => {
    const db = await createTestDb();
    try {
      const sessionId = 'ses_reentrant_query_close';
      await appendTestEvent(db.repos, sessionId, 1);

      const qgate = deferred();
      let rsettled = false;
      let qfinished = false;
      let rclosing: Promise<void> | undefined;
      let publisher!: PersistentEventPublisher;

      const wrappedSource = {
        highWaterMark: db.source.highWaterMark,
        async listWindow(s: string, o: any) {
          // 在同步前段立即发起 close
          rclosing = publisher.close().then(() => {
            rsettled = true;
          });
          await qgate.promise;
          const rows = await db.source.listWindow(s, o);
          qfinished = true;
          return rows;
        }
      };

      publisher = new PersistentEventPublisher(wrappedSource);
      publisher.subscribe(
        sessionId,
        () => {
          throw new Error('callback should not be called after close');
        },
        { afterSequence: 0 }
      );

      // 等待宏任务让 listWindow 被调用并触发 close
      await new Promise((r) => setTimeout(r, 40));

      // 在 query deferred 释放前，close 必须保持 pending（rsettled 必须是 false）
      expect(rsettled).toBe(false);
      expect(qfinished).toBe(false);

      // 释放 query
      qgate.resolve();
      await rclosing;
      expect(qfinished).toBe(true);
      expect(rsettled).toBe(true);
    } finally {
      await db.cleanup();
    }
  });

  it('反例B: highWaterMark 内部重入调用 close，subscribe 必须抛错拒绝且无残留订阅与定时器', async () => {
    let closedPromise: Promise<void> | undefined;
    let publisher!: PersistentEventPublisher;

    const wrappedSource = {
      highWaterMark() {
        closedPromise = publisher.close();
        return 0;
      },
      async listWindow() {
        return [];
      }
    };

    publisher = new PersistentEventPublisher(wrappedSource);

    expect(() => {
      publisher.subscribe('ses_hwm_reentrant', () => {});
    }).toThrow(/PersistentEventPublisher is closed/);

    await closedPromise;

    // 验证无任何订阅残留（没有 listener 被唤醒）
    expect(() => publisher.wake('ses_hwm_reentrant')).not.toThrow();
  });

  it('查询中/回调中 unsubscribe 和替换订阅', async () => {
    const db = await createTestDb();
    try {
      const sessionId = 'ses_unsub_and_replace';
      await appendTestEvent(db.repos, sessionId, 1);
      await appendTestEvent(db.repos, sessionId, 2);

      // 场景 1：查询中 unsubscribe
      const queryGate = deferred();
      let queryStarted = false;
      const wrappedSource = {
        highWaterMark: db.source.highWaterMark,
        async listWindow(sid: string, opts: any) {
          queryStarted = true;
          await queryGate.promise;
          return db.source.listWindow(sid, opts);
        }
      };

      const publisher1 = new PersistentEventPublisher(wrappedSource);
      const received1: number[] = [];
      const cancel1 = publisher1.subscribe(
        sessionId,
        (evt) => {
          received1.push(evt.sequence);
        },
        { afterSequence: 0 }
      );

      await vi.waitFor(() => expect(queryStarted).toBe(true));
      cancel1(); // 查询中取消
      queryGate.resolve();

      await vi.waitFor(() => {
        expect(received1.length).toBe(0);
      });
      await publisher1.close();

      // 场景 2：回调中 unsubscribe
      const publisher2 = new PersistentEventPublisher(db.source);
      const received2: number[] = [];
      let cancel2!: () => void;
      cancel2 = publisher2.subscribe(
        sessionId,
        (evt) => {
          received2.push(evt.sequence);
          if (evt.sequence === 1) {
            cancel2();
          }
        },
        { afterSequence: 0 }
      );

      await vi.waitFor(() => {
        expect(received2).toEqual([1]);
      });

      publisher2.wake(sessionId);
      await new Promise((r) => setTimeout(r, 50));
      expect(received2).toEqual([1]);

      // 场景 3：替换订阅是全新身份，不影响替代者
      const received3: number[] = [];
      publisher2.subscribe(
        sessionId,
        (evt) => {
          received3.push(evt.sequence);
        },
        { afterSequence: 1 }
      );

      await vi.waitFor(() => {
        expect(received3).toEqual([2]);
      });

      await publisher2.close();
    } finally {
      await db.cleanup();
    }
  });

  it('wake 与 drain 交错不会重复投递或丢失事件', async () => {
    const db = await createTestDb();
    try {
      const sessionId = 'ses_interleaved';
      const publisher = new PersistentEventPublisher(db.source);
      const received: number[] = [];

      publisher.subscribe(
        sessionId,
        async (evt) => {
          await new Promise((r) => setTimeout(r, 10));
          received.push(evt.sequence);
        },
        { afterSequence: 0 }
      );

      await appendTestEvent(db.repos, sessionId, 1);
      publisher.wake(sessionId);
      publisher.wake(sessionId);

      await appendTestEvent(db.repos, sessionId, 2);
      publisher.wake(sessionId);

      await appendTestEvent(db.repos, sessionId, 3);
      publisher.wake(sessionId);
      publisher.wake(sessionId);

      await vi.waitFor(() => {
        expect(received).toEqual([1, 2, 3]);
      });

      await publisher.close();
    } finally {
      await db.cleanup();
    }
  });

  it('批量处理给其他工作机会（让出事件循环）', async () => {
    const db = await createTestDb();
    try {
      const sessionId = 'ses_batch_yield';
      const totalEvents = 250;
      for (let i = 1; i <= totalEvents; i++) {
        await appendTestEvent(db.repos, sessionId, i);
      }

      const publisher = new PersistentEventPublisher(db.source);
      const received: number[] = [];
      let otherWorkRan = false;

      setImmediate(() => {
        otherWorkRan = true;
      });

      const done = deferred();
      publisher.subscribe(
        sessionId,
        (evt) => {
          received.push(evt.sequence);
          if (received.length === totalEvents) {
            done.resolve();
          }
        },
        { afterSequence: 0 }
      );

      await done.promise;
      expect(received.length).toBe(totalEvents);
      expect(otherWorkRan).toBe(true);

      await publisher.close();
    } finally {
      await db.cleanup();
    }
  });

  it('没有 listener 时不反复查询', async () => {
    const db = await createTestDb();
    try {
      const sessionId = 'ses_no_listener';
      let listWindowCalls = 0;
      const wrappedSource = {
        highWaterMark: db.source.highWaterMark,
        async listWindow(sid: string, opts: any) {
          listWindowCalls++;
          return db.source.listWindow(sid, opts);
        }
      };

      const publisher = new PersistentEventPublisher(wrappedSource);

      publisher.wake(sessionId);
      await new Promise((r) => setTimeout(r, 50));
      expect(listWindowCalls).toBe(0);

      const cancel = publisher.subscribe(sessionId, () => {});
      cancel();

      publisher.wake(sessionId);
      await new Promise((r) => setTimeout(r, 50));
      expect(listWindowCalls).toBe(0);

      await publisher.close();
    } finally {
      await db.cleanup();
    }
  });

  it('高水位读取失败直接抛出且不漏订阅与定时器', async () => {
    const errorSource = {
      highWaterMark() {
        throw new Error('Database disk I/O error');
      },
      async listWindow() {
        return [];
      }
    };

    const publisher = new PersistentEventPublisher(errorSource);

    expect(() => {
      publisher.subscribe('ses_hwm_fail', () => {});
    }).toThrow('Database disk I/O error');

    publisher.wake('ses_hwm_fail');
    await publisher.close();
  });

  it('显式 afterSequence 参数校验合法性', async () => {
    const dummySource = {
      highWaterMark: () => 0,
      listWindow: async () => []
    };
    const publisher = new PersistentEventPublisher(dummySource);

    expect(() => {
      publisher.subscribe('s', () => {}, { afterSequence: -1 });
    }).toThrow(RangeError);

    expect(() => {
      publisher.subscribe('s', () => {}, { afterSequence: NaN });
    }).toThrow(RangeError);

    expect(() => {
      publisher.subscribe('s', () => {}, { afterSequence: 1.5 });
    }).toThrow(RangeError);

    expect(() => {
      publisher.subscribe('s', () => {}, { afterSequence: '0' as any });
    }).toThrow(RangeError);

    await publisher.close();
  });

  it('listener 改动收到的事件对象不能污染其他 listener 或后续重放', async () => {
    const db = await createTestDb();
    try {
      const sessionId = 'ses_clone_protection';
      await appendTestEvent(db.repos, sessionId, 1, { user: 'alice', mutable: [1, 2] });

      const publisher = new PersistentEventPublisher(db.source);
      let listenerBData: any;

      publisher.subscribe(
        sessionId,
        (evt) => {
          (evt.data as any).user = 'malicious';
          (evt.data as any).mutable.push(999);
        },
        { afterSequence: 0 }
      );

      publisher.subscribe(
        sessionId,
        (evt) => {
          listenerBData = evt.data;
        },
        { afterSequence: 0 }
      );

      await vi.waitFor(() => {
        expect(listenerBData).toBeDefined();
      });

      expect(listenerBData.user).toBe('alice');
      expect(listenerBData.mutable).toEqual([1, 2]);

      await publisher.close();
    } finally {
      await db.cleanup();
    }
  });

  it('不同 session 和不同订阅可以并行处理互不阻塞', async () => {
    const db = await createTestDb();
    try {
      const session1 = 'ses_parallel_1';
      const session2 = 'ses_parallel_2';
      await appendTestEvent(db.repos, session1, 1);
      await appendTestEvent(db.repos, session2, 1);

      const publisher = new PersistentEventPublisher(db.source);
      const gate1 = deferred();
      const order: string[] = [];

      publisher.subscribe(
        session1,
        async () => {
          order.push('s1_start');
          await gate1.promise;
          order.push('s1_end');
        },
        { afterSequence: 0 }
      );

      publisher.subscribe(
        session2,
        async () => {
          order.push('s2_done');
        },
        { afterSequence: 0 }
      );

      await vi.waitFor(() => {
        expect(order).toContain('s1_start');
        expect(order).toContain('s2_done');
      });

      gate1.resolve();
      await vi.waitFor(() => {
        expect(order).toContain('s1_end');
      });

      await publisher.close();
    } finally {
      await db.cleanup();
    }
  });

  it('close 具有幂等性，多次调用返回同一 Promise 且正常关闭', async () => {
    const db = await createTestDb();
    try {
      const publisher = new PersistentEventPublisher(db.source);
      publisher.subscribe('s_idem', () => {});

      const p1 = publisher.close();
      const p2 = publisher.close();
      expect(p1).toBe(p2);
      await p1;
      expect(() => publisher.subscribe('s_idem', () => {})).toThrow(
        'PersistentEventPublisher is closed'
      );
    } finally {
      await db.cleanup();
    }
  });

  it('零订阅停止定时器，新订阅重启定时器', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const db = await createTestDb();
    try {
      const sessionId = 'ses_timer_lifecycle';
      const publisher = new PersistentEventPublisher(db.source);

      const cancel1 = publisher.subscribe(sessionId, () => {});
      const cancel2 = publisher.subscribe(sessionId, () => {});

      cancel1();
      cancel2();

      const received: number[] = [];
      publisher.subscribe(sessionId, (evt) => {
        received.push(evt.sequence);
      });

      await appendTestEvent(db.repos, sessionId, 1);
      await vi.advanceTimersByTimeAsync(1000);

      expect(received).toEqual([1]);
      await publisher.close();
    } finally {
      vi.useRealTimers();
      await db.cleanup();
    }
  });

  it('失败只在下一次唤醒或定时器重试，不同步无休止重试', async () => {
    const db = await createTestDb();
    try {
      const sessionId = 'ses_no_infinite_retry';
      await appendTestEvent(db.repos, sessionId, 1);

      let attempts = 0;
      const publisher = new PersistentEventPublisher(db.source);

      publisher.subscribe(
        sessionId,
        () => {
          attempts++;
          throw new Error('Failure on turn');
        },
        { afterSequence: 0 }
      );

      await new Promise((r) => setTimeout(r, 80));
      expect(attempts).toBe(1);

      publisher.wake(sessionId);
      await new Promise((r) => setTimeout(r, 80));
      expect(attempts).toBe(2);

      await publisher.close();
    } finally {
      await db.cleanup();
    }
  });

  it('subscribe 入参 sessionId 和 listener 类型安全校验', async () => {
    const dummySource = {
      highWaterMark: () => 0,
      listWindow: async () => []
    };
    const publisher = new PersistentEventPublisher(dummySource);

    expect(() => {
      publisher.subscribe('' as any, () => {});
    }).toThrow(TypeError);

    expect(() => {
      publisher.subscribe(null as any, () => {});
    }).toThrow(TypeError);

    expect(() => {
      publisher.subscribe('s', null as any);
    }).toThrow(TypeError);

    await publisher.close();
  });
});
