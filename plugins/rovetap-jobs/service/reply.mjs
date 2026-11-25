// Thread receipt delivery.
//
// Two equivalent backends:
//  - 'lark-api' (default, best for isolated/fake Lark e2e): POST /reply with a
//    durable caller-owned `uuid`, so retrying an unknown outcome is idempotent;
//  - 'dutydeck-cli': the supported
//      dutydeck lark send <markdown> --app <app> --database <db> \
//        --reply-to <root|message> --in-thread --json
//    path. Each CLI spawn mints its own uuid, so an `unknown_outcome` exit (5)
//    must NOT be blindly retried (it could double-post).
//
// Both return `{outcome:'sent'|'unknown'|'failed', messageId?, reason?}`.

import { execFile } from 'node:child_process';

export function buildDutydeckSendArgs({ markdown, app, database, replyTo, inThread = true }) {
  const args = ['lark', 'send', markdown, '--json'];
  if (app) args.push('--app', app);
  if (database) args.push('--database', database);
  if (replyTo) args.push('--reply-to', replyTo);
  if (inThread) args.push('--in-thread');
  return args;
}

function execFileText(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        error,
        code: error?.code === undefined ? 0 : (typeof error.code === 'number' ? error.code : 1),
        stdout: stdout?.toString?.() ?? '',
        stderr: stderr?.toString?.() ?? '',
      });
    });
  });
}

function parseJsonLine(stdout) {
  const line = stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{') && l.endsWith('}'));
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

export class ReplySender {
  constructor(config, larkClient) {
    this.config = config;
    this.lark = larkClient;
    this.mode = config.reply.mode;
    // Direct API reuses our durable uuid; a fresh CLI process does not.
    this.idempotent = this.mode === 'lark-api';
  }

  async send({ uuid, replyTo, text }) {
    if (this.mode === 'lark-api') {
      if (!this.lark) return { outcome: 'failed', reason: 'lark client unavailable' };
      return this.lark.replyText({ replyToMessageId: replyTo, text, uuid, inThread: true });
    }
    return this.#sendCli({ text, replyTo });
  }

  async #sendCli({ text, replyTo }) {
    const r = this.config.reply;
    const args = buildDutydeckSendArgs({ markdown: text, app: r.app, database: r.database, replyTo, inThread: true });
    const result = await execFileText(r.dutydeckBin, args, r.timeoutMs);
    const envelope = parseJsonLine(result.stdout);
    if (result.code === 0 && envelope?.ok === true) {
      const messageId = envelope.data?.message_id ?? envelope.messageId;
      return messageId ? { outcome: 'sent', messageId } : { outcome: 'unknown', reason: 'missing_message_id' };
    }
    const code = envelope?.error?.code ?? '';
    if (result.code === 5 || code === 'unknown_outcome') {
      return { outcome: 'unknown', reason: 'dutydeck_unknown_outcome' };
    }
    if (result.error?.code === 'ENOENT' || result.error?.code === 'EACCES') {
      return { outcome: 'failed', reason: `cli_${result.error.code}` };
    }
    return { outcome: 'failed', reason: code || `exit_${result.code}` };
  }
}
