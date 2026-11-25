import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplySender, buildDutydeckSendArgs } from '../service/reply.mjs';

describe('dutydeck lark send argv contract', () => {
  it('builds the exact named CLI arguments for in-thread reply', () => {
    const args = buildDutydeckSendArgs({
      markdown: '✅ 已接单', app: 'cli_x', database: '/srv/dutydeck.db', replyTo: 'om_root', inThread: true,
    });
    expect(args).toEqual([
      'lark', 'send', '✅ 已接单', '--json',
      '--app', 'cli_x', '--database', '/srv/dutydeck.db',
      '--reply-to', 'om_root', '--in-thread',
    ]);
  });

  it('omits --in-thread when disabled', () => {
    const args = buildDutydeckSendArgs({ markdown: 'x', replyTo: 'om1', inThread: false });
    expect(args).not.toContain('--in-thread');
    expect(args).toContain('--reply-to');
  });
});

describe('ReplySender dutydeck-cli classification', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  async function senderFor(mode: string) {
    dir = await mkdtemp(join(tmpdir(), 'rvj-dd-'));
    const bin = join(dir, 'fake-dutydeck.mjs');
    await writeFile(bin, `#!/usr/bin/env node
const mode = process.env.FAKE_DD_MODE;
if (mode === 'unknown') { process.stdout.write(JSON.stringify({ ok:false, error:{ code:'unknown_outcome', message:'maybe sent' } })); process.exit(5); }
if (mode === 'notfound') { process.stdout.write(JSON.stringify({ ok:false, error:{ code:'not_found', message:'no bot' } })); process.exit(4); }
process.stdout.write(JSON.stringify({ ok:true, data:{ message_id:'om_cli_1' } }));
`);
    await chmod(bin, 0o755);
    process.env.FAKE_DD_MODE = mode;
    const config: any = { reply: { mode: 'dutydeck-cli', dutydeckBin: bin, app: 'cli_x', database: join(dir, 'd.db'), timeoutMs: 4000 } };
    return new ReplySender(config, null);
  }

  it('parses ok JSON message id and is non-idempotent', async () => {
    const s = await senderFor('ok');
    expect(s.idempotent).toBe(false); // a fresh CLI mints its own uuid
    const r = await s.send({ uuid: 'u1', replyTo: 'om_root', text: 'hi' });
    expect(r).toEqual({ outcome: 'sent', messageId: 'om_cli_1' });
  });

  it('maps exit 5 unknown_outcome to protected unknown (do not auto-resend)', async () => {
    const s = await senderFor('unknown');
    const r = await s.send({ uuid: 'u2', replyTo: 'om_root', text: 'hi' });
    expect(r.outcome).toBe('unknown');
  });

  it('maps deterministic not_found to failed', async () => {
    const s = await senderFor('notfound');
    const r = await s.send({ uuid: 'u3', replyTo: 'om_root', text: 'hi' });
    expect(r.outcome).toBe('failed');
  });
});
