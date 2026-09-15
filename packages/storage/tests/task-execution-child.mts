import { createRepositories } from '../src/index.ts';
import { canonicalExecutionJson, type AcceptedTaskInput, type TaskRequestV1 } from '@dutydeck/shared';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
const repos = createRepositories(process.argv[2]!);
if (process.argv[3] === 'migration-crash') {
  await repos.sessions.save({ id: 'legacy', runId: 'legacy-run', agentId: 'a', cwd: '/tmp', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await repos.tasks.save({ id: 'legacy-task', sessionId: 'legacy', prompt: 'old', status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (sql) {
    if (sql === 'INSERT INTO task_requests VALUES (?,?,?,?,?,?,?)') process.kill(process.pid, 'SIGKILL');
    return prepare.call(this, sql);
  };
  repos.execution.upgradeLegacy();
  throw new Error('Expected migration crash');
}
repos.execution.upgradeLegacy();
const claim = repos.control.attachRuntime('child-runtime');
const execution = repos.execution.bind(claim);
const f = { sessionId: 'child-session', runId: 'child-run' };
execution.createSession({ id:f.sessionId,runId:f.runId,agentId:'test',cwd:'/tmp',state:'idle',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString() });
const request:TaskRequestV1={version:1,namespace:'runtime',key:'crash',sessionId:f.sessionId,actor:{kind:'unspecified'},prompt:'hello',mode:'queue',skills:[],options:{},sources:[],sourcePayload:null};
const content={version:2 as const,executionOptions:{permissionMode:'ask' as const},prompt:'hello',executionContext:{agentPrompt:'hello'},contentSources:[]};
const input:AcceptedTaskInput={...content,digest:createHash('sha256').update(canonicalExecutionJson(content)).digest('hex')};
execution.acceptTask(f,request,input,'back');
const result=execution.claimNext(f)!;
process.stdout.write(JSON.stringify(result.attempt)+'\n');
setInterval(()=>{},1000);
