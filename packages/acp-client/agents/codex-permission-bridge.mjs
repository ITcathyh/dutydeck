#!/usr/bin/env node
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { launchAgent } from './launcher-process.mjs';

const executable = process.env.dutydeck_codex_executable;
const mode = process.env.dutydeck_codex_permission_mode;
if (!executable || !['ask', 'approve-reads', 'deny-all', 'full-trust'].includes(mode)) {
  process.stderr.write('CODEX_APPROVAL_POLICY_REQUIRED: Missing Dutydeck Codex launch policy.\n');
  process.exit(2);
}
const env = { ...process.env, CODEX_PATH: executable };
delete env.dutydeck_codex_executable;
delete env.dutydeck_codex_permission_mode;
const args = process.argv.slice(2);
if (!args.includes('app-server')) launchAgent(executable, args, env);
else {
  const child = launchAgent(executable, args, env, { stdio: ['pipe', 'inherit', 'inherit'] });
  // codex-acp supplies its own policy on every turn, overriding native config.
  // Apply the administrator's policy at the final native protocol boundary,
  // including resumed threads. Safe native reads remain subject to Codex's
  // untrusted policy; privileged operations request the ACP client's decision.
  const trusted = mode === 'full-trust';
  let pending = '';
  const decoder = new StringDecoder('utf8');
  const input = new Transform({
    transform(chunk, encoding, callback) {
      pending += decoder.write(chunk);
      try {
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (['thread/start', 'thread/resume', 'thread/fork', 'turn/start'].includes(message.method)) {
            const params = message.params ??= {};
            params.approvalPolicy = trusted ? 'never' : 'untrusted';
            params.approvalsReviewer = 'user';
            if (message.method === 'turn/start') params.sandboxPolicy = trusted ? { type: 'dangerFullAccess' } : { type: 'readOnly', networkAccess: false };
            else params.sandbox = trusted ? 'danger-full-access' : 'read-only';
          }
          this.push(`${JSON.stringify(message)}\n`);
        }
        callback();
      } catch { callback(new Error('CODEX_APPROVAL_PROTOCOL_INVALID')); }
    },
    flush(callback) { pending += decoder.end(); callback(pending.trim() ? new Error('CODEX_APPROVAL_PROTOCOL_INCOMPLETE') : undefined); }
  });
  input.on('error', error => {
    process.stderr.write(`${error.message}\n`);
    process.stdin.destroy();
    // Reuse the launcher's group cleanup and bounded SIGKILL escalation.
    process.kill(process.pid, 'SIGTERM');
  });
  child.stdin.on('error', () => process.stdin.unpipe(input));
  process.stdin.pipe(input).pipe(child.stdin);
}
