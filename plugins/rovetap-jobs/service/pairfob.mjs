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

/** Parse the promised single JSON object, tolerating a trailing log line. */
export function parseEnvelope(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    for (let i = text.length - 1; i >= 0; i -= 1) {
      if (text[i] !== '}') continue;
      try {
        return JSON.parse(text.slice(text.indexOf('{'), i + 1));
      } catch { /* keep scanning */ }
    }
    return null;
  }
}

/**
 * Low-level execFile wrapper. Resolves `{code,stdout,stderr}` for any completed
 * process (including non-zero exit); rejects only when the process could not be
 * spawned at all or the call itself failed before a process outcome.
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
        if (error) {
          error.stdout = stdout?.toString?.() ?? '';
          error.stderr = stderr?.toString?.() ?? '';
          reject(error);
          return;
        }
        resolve({ code: 0, stdout: stdout?.toString?.() ?? '', stderr: stderr?.toString?.() ?? '' });
      },
    );
    child.once('spawn', () => onSpawn?.());
    if (stdin !== undefined) child.stdin?.end(stdin, 'utf8');
  });
}

function classifySpawnError(error) {
  // ENOENT/EACCES happen before any hub write; everything else is treated as an
  // uncertain write by the submit caller.
  return error && (error.code === 'ENOENT' || error.code === 'EACCES');
}

/**
 * Submit one job.
 * @returns {Promise<
 *  {outcome:'ok', taskId:string, leaderId:string, phase?:string, data:object} |
 *  {outcome:'rejected', code:string, message:string} |
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
    // Timeout, signal kill, maxBuffer, or exit!=0: the hub may have committed.
    return { outcome: 'unknown', reason: error.killed ? 'timeout_or_signal' : `exit_${error.code ?? 'error'}`, stdout: error.stdout ?? '' };
  }
  const envelope = parseEnvelope(result.stdout);
  if (envelope && envelope.ok === true && envelope.data && typeof envelope.data.task_id === 'string') {
    return {
      outcome: 'ok',
      taskId: envelope.data.task_id,
      leaderId: typeof envelope.data.leader_id === 'string' ? envelope.data.leader_id : '',
      phase: typeof envelope.data.phase === 'string' ? envelope.data.phase : undefined,
      data: envelope.data,
    };
  }
  if (envelope && envelope.ok === false && envelope.error) {
    return {
      outcome: 'rejected',
      code: String(envelope.error.code ?? 'unknown'),
      message: String(envelope.error.message ?? 'project submit rejected'),
    };
  }
  // Exit 0/non-zero without a verified success envelope: cannot know.
  return { outcome: 'unknown', reason: 'missing_ok_envelope', stdout: result.stdout };
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
    const envelope = parseEnvelope(error.stdout ?? '');
    if (envelope && envelope.ok === false) {
      const code = String(envelope.error?.code ?? '');
      if (/not[_-]?found|no[_-]?such|missing/i.test(code)) return { outcome: 'not_found', code };
      return { outcome: 'error', reason: `${code}: ${envelope.error?.message ?? ''}` };
    }
    if (classifySpawnError(error)) return { outcome: 'error', reason: `not_spawned:${error.code}` };
    return { outcome: 'error', reason: error.killed ? 'timeout' : `exit_${error.code ?? 'error'}` };
  }
  const envelope = parseEnvelope(result.stdout);
  if (envelope && envelope.ok === true && envelope.data) {
    const d = envelope.data;
    if (typeof d.task_id === 'string' && typeof d.phase === 'string') {
      return { outcome: 'ok', taskId: d.task_id, leaderId: typeof d.leader_id === 'string' ? d.leader_id : '', phase: d.phase, data: d };
    }
  }
  if (envelope && envelope.ok === false) {
    const code = String(envelope.error?.code ?? '');
    if (/not[_-]?found|no[_-]?such|missing/i.test(code)) return { outcome: 'not_found', code };
    return { outcome: 'error', reason: `${code}: ${envelope.error?.message ?? ''}` };
  }
  return { outcome: 'error', reason: 'malformed_status' };
}
