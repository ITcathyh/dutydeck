import { createRepositories } from '../../src/index.js';

const filename = process.argv[2];
if (!filename) throw new Error('Missing fixture database');
const repositories = createRepositories(filename, { mode: 'runtime', newDatabaseAuthority: 'ledger_v1' });
const claim = repositories.control.attachRuntime('original-creator');
const execution = repositories.execution.bind(claim);
const fence = { sessionId: 'creation-session', runId: 'creation-run' };
const at = new Date().toISOString();
execution.createSession({ id: fence.sessionId, runId: fence.runId, agentId: 'fixture', cwd: process.cwd(), state: 'created', createdAt: at, updatedAt: at });
const resource = process.argv[3] === 'legacy'
  ? execution.beforeCreate(fence, { resourceId: 'factory', kind: 'operation' })
  : execution.beforeControlledOperation(fence, { resourceId: 'factory', driverInstanceId: 'original-driver' });
if (process.argv[3] === 'child') execution.beforeCreate(fence, { resourceId: 'unconfirmed-child', kind: 'process', parentResourceId: resource.resourceId });
process.on('message', message => {
  if (message !== 'release') throw new Error('Unknown fixture command');
  claim.release(); repositories.close();
  process.send?.({ kind: 'released' });
});
process.send?.({ kind: 'ready', resource });
