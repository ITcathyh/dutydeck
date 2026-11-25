#!/usr/bin/env node
// Test double for the real `pairfob project submit|status` contract CLI.
// It is a REAL executable spawned with an absolute path + argument array (no
// shell). State is a tiny JSON "hub" at $FAKE_PAIRFOB_HUB so duplicate submits,
// concurrency and restart reconciliation observe the same persisted tasks.
//
// FAKE_PAIRFOB_MODE:
//   ok (default)  - print the promised envelope
//   drop          - persist the task, then exit non-zero with no envelope
//   malformed     - print a partial non-JSON success-looking body

import { readFileSync } from 'node:fs';
import { writeHubState } from '../helpers/hub-state.mjs';

const args = process.argv.slice(2);
const hubPath = process.env.FAKE_PAIRFOB_HUB;
const mode = process.env.FAKE_PAIRFOB_MODE || 'ok';

function loadHub() {
  try { return JSON.parse(readFileSync(hubPath, 'utf8')); }
  catch { return { keys: {}, seq: 0, submitCount: 0, statusCalls: 0 }; }
}
function saveHub(h) { writeHubState(hubPath, h); }
function emit(o) { process.stdout.write(JSON.stringify(o)); }
function opt(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function fingerprint(p) { return JSON.stringify(p); }

const [group, command] = args;

if (group === 'project' && command === 'submit') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    let payload;
    try { payload = JSON.parse(input || '{}'); }
    catch { emit({ ok: false, error: { code: 'bad_stdin_json', message: 'invalid JSON' } }); process.exit(0); }

    const key = payload.source_key;
    if (!key) { emit({ ok: false, error: { code: 'missing_key', message: 'source_key required' } }); process.exit(0); }

    const hub = loadHub();
    hub.submitCount += 1;
    hub.lastPayload = payload;
    hub.invocations = hub.invocations || [];
    hub.invocations.push({
      kind: 'submit', key, at: Date.now(),
      socket: process.env.ROVETAP_PROJECT_SOCKET ?? null,
      tokenFile: process.env.ROVETAP_PROJECT_TOKEN_FILE ?? null,
      materials: Array.isArray(payload.materials) ? payload.materials.length : -1,
      actor: payload.actor ?? null,
    });

    const existing = hub.keys[key];
    if (existing) {
      saveHub(hub);
      emit({ ok: true, data: { task_id: existing.taskId, leader_id: existing.leaderId, phase: existing.phase } });
      return;
    }

    hub.seq += 1;
    const record = {
      taskId: `pt_${String(hub.seq).padStart(6, '0')}`,
      leaderId: 'pl_leader_1',
      phase: hub.defaultPhase || 'todo',
      fingerprint: fingerprint(payload),
    };
    hub.keys[key] = record;
    saveHub(hub);

    if (mode === 'drop') { process.stderr.write('simulated stdout loss after commit\n'); process.exit(7); }
    if (mode === 'malformed') { process.stdout.write('{"ok":true,"data":{"task_id":"pt_broken"'); process.exit(0); }
    emit({ ok: true, data: { task_id: record.taskId, leader_id: record.leaderId, phase: record.phase } });
  });
} else if (group === 'project' && command === 'status') {
  const key = opt('--key');
  const hub = loadHub();
  hub.statusCalls += 1;
  saveHub(hub);
  const record = hub.keys[key];
  if (!record) { emit({ ok: false, error: { code: 'not_found', message: `unknown source key ${key}` } }); process.exit(0); }
  emit({ ok: true, data: { task_id: record.taskId, leader_id: record.leaderId, phase: record.phase } });
} else {
  emit({ ok: false, error: { code: 'bad_args', message: args.join(' ') } });
  process.exit(2);
}
