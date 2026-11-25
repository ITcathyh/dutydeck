// Client for the real `pairfob project submit|status` contract CLI.
//
// Hard rules from the cross-repo contract:
//  - the executable is an absolute path invoked with an argument ARRAY, never a shell;
//  - submit gets the UTF-8 JSON payload on stdin;
//  - ROVETAP_PROJECT_SOCKET / ROVETAP_PROJECT_TOKEN_FILE select the isolated hub
//    socket and the project-scoped credential file;
//  - success stdout is one `{ok:true,data:{task_id,leader_id,phase,...}}`;
//  - business failure is `{ok:false,error:{code,message}}`;
//  - if a submit's outcome is unknown (timeout / killed / malformed stdout /
//    disconnect), the caller must NOT resubmit: reconcile with status by the
//    same stable source key.
//
// Adjudication mirrors cmd/pairfob/project.go: a non-zero exit still carries
// the one JSON envelope on stdout, so the envelope — not the exit code — decides.
// Three classes are safe to act on without a source-key reconcile:
//  - 'unreachable' is emitted ONLY for the unix dial failure (projectRoundTrip
//    returns uncertain=false before any byte is written): safe to back off and
//    resubmit the same payload with its already resolved material;
//  - the explicit refusal/config family below positively says the job was not
//    created and warrants one correct notice in the original topic;
//  - unknown_outcome, internal, usage and anything else that does not prove the
//    hub refused (including success-shaped data missing identity fields) stay
//    'unknown': reconcile by source key, never report a rejection or resubmit.

import { execFile } from 'node:child_process';

function projectEnv(config) {
  // Explicit per-service extraEnv wins nothing sensitive; it carries test hooks
  // and any deployment variables the executable needs. The contract socket and
  // token file are set explicitly and cannot be overridden by extraEnv.
  const env = { ...process.env, ...(config.extraEnv ?? {}) };
  if (config.socket) env.ROVETAP_PROJECT_SOCKET = config.socket;
  if (config.tokenFile) env.ROVETAP_PROJECT_TOKEN_FILE = config.tokenFile;
  return env;
}

/**
 * Parse the promised stdout: exactly one JSON object (the project.go contract
 * is one envelope per invocation, with logs on stderr). Output containing
 * log lines, concatenated objects or other garbage is rejected rather than
 * partially extracted: callers then treat the result as an unconfirmed receipt
 * and reconcile by source key. A single native parse also avoids the quadratic
 * cost of rescanning every closing brace in megabytes of garbage.
 */
export function parseEnvelope(stdout) {
  if (typeof stdout !== 'string') return null;
  const text = stdout.trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Low-level execFile wrapper. Resolves `{code,stdout,stderr}` for any completed
 * process (including non-zero exit and timeout/signal kills); rejects only when
 * the process could not be spawned at all or the call failed before a process
 * outcome (ENOENT/EACCES and similar spawn errors).
 */
function run(bin, args, { stdin, env, timeoutMs = 20_000, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(
      bin,
      args,
      { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        const out = stdout?.toString?.() ?? error?.stdout?.toString?.() ?? '';
        const err = stderr?.toString?.() ?? error?.stderr?.toString?.() ?? '';
        if (error) {
          const completedNonZero = typeof error.code === 'number';
          const killedByTimeout = error.killed === true || Boolean(error.signal);
          if (!completedNonZero && !killedByTimeout) {
            error.stdout = out;
            error.stderr = err;
            reject(error);
            return;
          }
          resolve({
            code: typeof error.code === 'number' ? error.code : null,
            systemCode: typeof error.code === 'string' ? error.code : null,
            signal: error.signal ?? null,
            killed: Boolean(error.killed),
            stdout: out,
            stderr: err,
          });
          return;
        }
        resolve({ code: 0, systemCode: null, signal: null, killed: false, stdout: out, stderr: err });
      },
    );
    child.once('spawn', () => onSpawn?.());
    if (stdin !== undefined && child.stdin) {
      // A short-lived CLI (e.g. /bin/false) can exit and close stdin while we
      // are still writing; the resulting EPIPE must not become an unhandled
      // stream 'error' that kills the plugin. The process outcome still arrives
      // through the execFile callback and is classified as an unknown write.
      child.stdin.on('error', () => { /* consumed by the execFile callback */ });
      child.stdin.end(stdin, 'utf8');
    }
  });
}

function classifySpawnError(error) {
  // ENOENT/EACCES happen before any hub write; everything else is treated as an
  // uncertain write by the submit caller.
  return error && (error.code === 'ENOENT' || error.code === 'EACCES');
}

// Error codes that positively mean this submission created no task and the
// original topic should receive one terminal explanation. This is the exit-4
// family plus the exit-2 local configuration failure in cmd/pairfob/project.go
// and the hub_project_job_intake*.go verdicts. Deliberately an allowlist:
// unknown/future codes stay reconcile-only instead of producing a false refusal.
const EXPLICIT_REJECTION_CODES = new Set([
  'rejected', // generic business refusal
  'forbidden', // bad project credential, project disabled, source-key ownership mismatch
  'conflict', // same source_key already stored with different content
  'invalid_argument', // payload failed intake validation before any write
  'too_large', // payload exceeded the intake limit before any write
  'not_found', // submit-time binding miss, e.g. configured project leader does not exist
  'project_closed', // project alias is closed and accepts no new jobs
  'configuration_error', // local socket/token configuration invalid (exit 2)
]);

function nonEmptyField(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * The promised success receipt is usable only when all three identity fields
 * are non-empty. Returns trimmed ids/phase so blank padding cannot reach
 * receipts or deep links.
 */
function readSuccessData(envelope) {
  const d = envelope && envelope.ok === true ? envelope.data : null;
  if (!d || typeof d !== 'object') return null;
  const taskId = nonEmptyField(d.task_id);
  const leaderId = nonEmptyField(d.leader_id);
  const phase = nonEmptyField(d.phase);
  if (!taskId || !leaderId || !phase) return null;
  return { taskId, leaderId, phase, data: d };
}

function transportReason(result) {
  if (result.killed || result.signal) return 'timeout_or_signal';
  if (result.code !== 0) return `exit_${result.code ?? result.systemCode ?? 'error'}`;
  return 'missing_ok_envelope';
}

/**
 * Submit one job.
 * @returns {Promise<
 *  {outcome:'ok', taskId:string, leaderId:string, phase:string, data:object} |
 *  {outcome:'rejected', code:string, message:string} |
 *  {outcome:'unreachable', code:string, message:string} |
 *  {outcome:'not_spawned', error:string} |
 *  {outcome:'unknown', reason:string, stdout?:string}>}
 */
export async function submitProjectJob(options) {
  const { bin, project, payload, socket, tokenFile, extraEnv, timeoutMs, onSpawn } = options;
  const args = ['project', 'submit', '--project', project, '--stdin'];
  const stdin = JSON.stringify(payload);
  let result;
  try {
    result = await run(bin, args, { stdin, env: projectEnv({ socket, tokenFile, extraEnv }), timeoutMs, onSpawn });
  } catch (error) {
    if (classifySpawnError(error)) {
      return { outcome: 'not_spawned', error: `${error.code}: ${error.message}` };
    }
    // Defensive: run() only rejects spawn-level failures. Anything else cannot
    // prove the hub did not commit, so reconcile by source key.
    return { outcome: 'unknown', reason: error.killed || error.signal ? 'timeout_or_signal' : `exit_${error.code ?? 'error'}`, stdout: error.stdout ?? '' };
  }
  const envelope = parseEnvelope(result.stdout);

  const success = readSuccessData(envelope);
  if (success) return { outcome: 'ok', ...success };

  if (envelope && envelope.ok === true) {
    // ok:true but task/leader/phase missing or blank: the job may exist, and a
    // status read by source key can still recover it. Never report rejection.
    return { outcome: 'unknown', reason: 'incomplete_success_envelope', stdout: result.stdout };
  }

  if (envelope && envelope.ok === false && envelope.error && typeof envelope.error === 'object') {
    const code = String(envelope.error.code ?? 'unknown');
    const message = String(envelope.error.message ?? 'project submit rejected');
    if (code === 'unreachable') {
      // The real CLI guarantees this is dial-before-write (exit 1); safe to
      // retry the identical payload rather than reconcile a nonexistent task.
      return { outcome: 'unreachable', code, message };
    }
    if (EXPLICIT_REJECTION_CODES.has(code)) {
      return { outcome: 'rejected', code, message };
    }
    // unknown_outcome / internal / usage / unknown future codes: none proves an
    // explicit refusal, so the caller only reconciles.
    return { outcome: 'unknown', reason: `${code}: ${message}`, stdout: result.stdout };
  }

  // Exit 0/non-zero without a verifiable envelope: cannot know the result.
  return { outcome: 'unknown', reason: transportReason(result), stdout: result.stdout };
}

/**
 * Read-only status lookup by the stable source key.
 * @returns {Promise<
 *  {outcome:'ok', taskId:string, leaderId:string, phase:string, data:object} |
 *  {outcome:'not_found', code?:string} |
 *  {outcome:'error', reason:string}>}
 */
export async function getProjectStatus(options) {
  const { bin, project, sourceKey, socket, tokenFile, extraEnv, timeoutMs } = options;
  const args = ['project', 'status', '--project', project, '--key', sourceKey];
  let result;
  try {
    result = await run(bin, args, { env: projectEnv({ socket, tokenFile, extraEnv }), timeoutMs });
  } catch (error) {
    if (classifySpawnError(error)) return { outcome: 'error', reason: `not_spawned:${error.code}` };
    // Defensive parse for any pre-outcome failure carrying an envelope.
    const envelope = parseEnvelope(error.stdout ?? '');
    const failure = classifyStatusFailure(envelope);
    if (failure) return failure;
    return { outcome: 'error', reason: error.killed ? 'timeout' : `exit_${error.code ?? 'error'}` };
  }
  const envelope = parseEnvelope(result.stdout);

  const success = readSuccessData(envelope);
  if (success) return { outcome: 'ok', ...success };

  const failure = classifyStatusFailure(envelope);
  if (failure) return failure;

  // An ok:true envelope missing required fields is not a usable status; the
  // caller backs off and reads again rather than adopting a partial identity.
  return { outcome: 'error', reason: envelope && envelope.ok === true ? 'incomplete_status' : 'malformed_status' };
}

function classifyStatusFailure(envelope) {
  if (!envelope || envelope.ok !== false) return null;
  const code = String(envelope.error?.code ?? '');
  if (/not[_-]?found|no[_-]?such|missing/i.test(code)) return { outcome: 'not_found', code: code || undefined };
  return { outcome: 'error', reason: `${code}: ${envelope.error?.message ?? ''}` };
}
