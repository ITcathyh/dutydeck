import { executeLocalRuntimeRequest, type LocalRuntimeRequestDependencies } from './local-runtime-request.js';
export interface MemoryManagementCliInput { session?: string; project?: string; content?: string; topic?: string; expectedFingerprint?: string; query?: string; name?: string; enabled?: string; url?: string; database?: string }
export async function runMemoryManagementCli(operation: string, id: string | undefined, input: MemoryManagementCliInput, dependencies: LocalRuntimeRequestDependencies = {}) {
  const required = (value: string | undefined, name: string) => { if (!value) throw new Error(`${name} is required`); return value; };
  const enc = encodeURIComponent;
  const session = () => `/api/sessions/${enc(required(input.session, '--session'))}`;
  const project = () => `/api/project-memory/${enc(required(input.project, '--project'))}`;
  const entry = () => enc(required(id, '<entry-id>'));
  const write = () => ({ content: required(input.content, '--content'), topic: input.topic, expectedFingerprint: required(input.expectedFingerprint, '--expected-fingerprint') });
  let endpoint: string; let method = 'GET'; let body: unknown;
  switch (operation) {
    case 'pool-list': endpoint = `${session()}/memory-pool`; break;
    case 'pool-revise': endpoint = `${session()}/memory-pool/${entry()}`; method = 'PATCH'; body = write(); break;
    case 'pool-remove': endpoint = `${session()}/memory-pool/${entry()}`; method = 'DELETE'; break;
    case 'project-list': endpoint = '/api/project-memory'; break;
    case 'project-create': endpoint = '/api/project-memory'; method = 'POST'; body = { name: required(input.name, '--name') }; break;
    case 'project-show': endpoint = project(); break;
    case 'project-enable':
      endpoint = project(); method = 'PATCH';
      if (!['true', 'false'].includes(input.enabled ?? '')) throw new Error('--enabled requires true or false');
      body = { enabled: input.enabled === 'true' }; break;
    case 'project-binding': endpoint = `${session()}/project-memory`; break;
    case 'project-bind': endpoint = `${session()}/project-memory`; method = 'PUT'; body = { projectId: required(input.project, '--project') }; break;
    case 'project-unbind': endpoint = `${session()}/project-memory`; method = 'PUT'; body = { projectId: null }; break;
    case 'project-add': endpoint = `${project()}/entries`; method = 'POST'; body = write(); break;
    case 'project-revise': endpoint = `${project()}/entries/${entry()}`; method = 'PATCH'; body = write(); break;
    case 'project-remove': endpoint = `${project()}/entries/${entry()}`; method = 'DELETE'; break;
    default: throw new Error('Unknown memory management operation');
  }
  if (input.query && ['pool-list', 'project-show'].includes(operation)) endpoint += `?q=${enc(input.query)}`;
  return executeLocalRuntimeRequest({ url: input.url, database: input.database, endpoint, method, body,
    errorSpec: { databaseRequired: 'MEMORY_DATABASE_REQUIRED', daemonUnavailable: 'MEMORY_DAEMON_UNAVAILABLE', localRuntimeRequired: 'MEMORY_LOCAL_REQUIRED', requestFailed: 'MEMORY_REQUEST_FAILED', requestFailedMessage: (status, message) => message ?? `HTTP ${status}` },
    createError: (code, message) => Object.assign(new Error(message), { code }) }, dependencies);
}
