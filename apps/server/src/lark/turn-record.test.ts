import { expect, it } from 'vitest';
import type { StoredLarkConfig } from './config.js';
import { fromRecord, mergeRestoredRecord, toRecord, turnRecordSchema } from './turn-record.js';

const mapping = { sessionId: 'session', externalId: 'reaction_request' };
const config = { appId: 'app' } as StoredLarkConfig;
const base = { app_id: 'app', chat_id: 'chat', task_name: 'stored title', prompt: 'original prompt', state: 'running',
  started_at: 123, turn: 1, sender_open_id: 'ou_sender', verification_auto: { phase: 'running', turn: 1 },
  final_delivery_attempts: 2, earlier_message_ids: ['om_old'] };

it.each([{ anchor_message_id: 'om_visible' }, { fallback_note: 'switched' }, { future_field: { entries: [3, null] } },
  { root_message_id: 'om_legacy' }, { progress_frozen: false, final_elements: [] }])('round-trips the original JSON with %j', fields => {
  const raw = { ...base, ...fields };
  const record = turnRecordSchema.parse(JSON.parse(JSON.stringify(raw)));
  const task = fromRecord(record, mapping, config);
  expect(toRecord(task)).toStrictEqual(raw);
  task.state = 'completed';
  expect(toRecord(task)).toStrictEqual({ ...raw, state: 'completed' });
});

it('preserves a concurrent decision and unknown fields while saving verification changes', () => {
  const saved = turnRecordSchema.parse({ ...base, future: 1 });
  const task = fromRecord(saved, mapping, config);
  const updated = { ...saved, future: 2, final_delivery_attempts: 3 };
  task.autoVerification = undefined;
  expect(JSON.parse(JSON.stringify(mergeRestoredRecord(task, toRecord(task), updated)))).toEqual({ ...updated, verification_auto: undefined });
  task.turn++;
  expect(toRecord(task)).not.toHaveProperty('future');
  expect(turnRecordSchema.safeParse({ ...base, progress_frozen: 'yes' }).success).toBe(false);
});

it('saves an in-place result element edit against a concurrently updated record', () => {
  const record = turnRecordSchema.parse({ ...base, final_elements: [{ content: 'before' }] });
  const latest = structuredClone(record);
  const task = fromRecord(record, mapping, config);
  task.finalElements![0]!.content = 'after';
  expect(mergeRestoredRecord(task, toRecord(task), latest).final_elements).toEqual([{ content: 'after' }]);
});
