import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { auditFixtureFile } from './verify-fidelity.mjs';

const root = dirname(fileURLToPath(import.meta.url));

test('all native fixtures pass privacy checks without changing token usage evidence', () => {
  for (const name of ['codex', 'traex', 'claude-main', 'claude-subagent']) {
    assert.ok(auditFixtureFile(join(root, `${name}.jsonl`)).lines > 0);
  }
  const rows = readFileSync(join(root, 'codex.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const usage = rows.filter(row => row.payload?.type === 'token_count');
  assert.equal(usage.length, 4);
  assert.equal(usage.at(-1).payload.info.total_token_usage.total_tokens, 92353);
  assert.equal(usage.at(-1).payload.info.total_token_usage.output_tokens, 132);
});

for (const [field, payload] of [
  ['creator_user_id', { creator_user_id: 'SYNTHETIC_REJECTED_USER' }],
  ['creator_account_id', { nested: [{ creator_account_id: 'SYNTHETIC_REJECTED_ACCOUNT' }] }],
  ['credits', { credits: { balance: 'SYNTHETIC_REJECTED_BALANCE' } }],
  ['plan_type', { plan_type: 'SYNTHETIC_REJECTED_PLAN' }],
  ['rate_limits', { rate_limits: { primary: { used_percent: 13, window_minutes: 10080, resets_at: 12345 }, secondary: null } }]
]) {
  test(`rejects reintroduced account field ${field} without printing its value`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixture-privacy-'));
    try {
      const fixture = join(directory, 'sample.jsonl');
      writeFileSync(fixture, `${JSON.stringify({ type: 'event_msg', payload })}\n`);
      assert.throws(() => auditFixtureFile(fixture), error => {
        assert.match(error.message, new RegExp(field));
        assert.ok(!error.message.includes('SYNTHETIC_REJECTED'));
        return true;
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
