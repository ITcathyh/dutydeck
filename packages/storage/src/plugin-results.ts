import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { pluginResultLimits as limits, type PluginResultDelivery, type PluginResultRepository, type PluginResultOAuthState } from '@dutydeck/shared';
const token = () => randomBytes(32).toString('base64url');
function delivery(r: any): PluginResultDelivery | undefined {
  if (!r) return;
  return { id: r.id, requester: { provider: r.requester_provider, tenant: r.requester_tenant, subject: r.requester_subject }, plugin: r.plugin, tool: r.tool,
    sessionId: r.session_id, runId: r.run_id, taskId: r.task_id, attemptId: r.attempt_id, callId: r.call_id, inputDigest: r.input_digest,
    target: JSON.parse(r.target_json), status: r.status, revision: r.revision, leaseToken: r.lease_token, leaseUntil: r.lease_until,
    fileCount: r.file_count, totalBytes: r.total_bytes, providerKey: r.provider_key, messageId: r.message_id ?? undefined,
    firstSendAt: r.first_send_at ?? undefined, createdAt: r.created_at, expiresAt: r.expires_at, errorCode: r.error_code ?? undefined };
}
export function createPluginResultRepository(db: Database.Database): PluginResultRepository {
  const get = (id: string) => delivery(db.prepare('SELECT * FROM plugin_result_deliveries WHERE id=?').get(id));
  const update = (sql: string, ...params: Array<string | number>) => db.prepare(sql).run(...params).changes;
  const remove = (id: string, status: string) => { update('UPDATE plugin_result_deliveries SET status=?,revision=revision+1,lease_until=0 WHERE id=?', status, id); update('DELETE FROM plugin_result_files WHERE delivery_id=?', id); };
  return {
    get,
    reserve: (input, now) => db.transaction(() => {
      const previous = delivery(db.prepare('SELECT * FROM plugin_result_deliveries WHERE session_id=? AND task_id=? AND attempt_id=? AND plugin=? AND tool=? AND call_id=?').get(input.sessionId,input.taskId,input.attemptId,input.plugin,input.tool,input.callId));
      if (previous) {
        if (previous.inputDigest !== input.inputDigest) throw new Error('RESULT_CALL_CONFLICT');
        if (previous.status === 'executing' && previous.leaseUntil <= now) { update("UPDATE plugin_result_deliveries SET status='execution_unknown',revision=revision+1 WHERE id=? AND status='executing'", previous.id); }
        return { delivery: get(previous.id)!, acquired: false };
      }
      const counts = db.prepare("SELECT COUNT(*) AS global_count, SUM(CASE WHEN requester_provider=? AND requester_tenant=? AND requester_subject=? THEN 1 ELSE 0 END) AS own_count FROM plugin_result_deliveries WHERE status='executing' AND lease_until>?").get(input.requester.provider,input.requester.tenant,input.requester.subject,now) as any;
      if (counts.global_count >= limits.globalConcurrent || counts.own_count >= limits.principalConcurrent) throw new Error('RESULT_BUSY');
      db.prepare(`INSERT INTO plugin_result_deliveries (id,requester_provider,requester_tenant,requester_subject,plugin,tool,session_id,run_id,task_id,attempt_id,call_id,input_digest,target_json,status,lease_token,lease_until,provider_key,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'executing',?,?,?,?,?)`).run(input.id,input.requester.provider,input.requester.tenant,input.requester.subject,input.plugin,input.tool,input.sessionId,input.runId,input.taskId,input.attemptId,input.callId,input.inputDigest,JSON.stringify(input.target),input.leaseToken,input.leaseUntil,input.providerKey,input.createdAt,input.expiresAt);
      return { delivery: get(input.id)!, acquired: true };
    }).immediate(),
    store: (id, lease, files, now) => db.transaction(() => {
      const row=get(id);
      if (!row || row.status !== 'executing' || row.leaseToken !== lease || row.leaseUntil <= now || row.expiresAt <= now) throw new Error('RESULT_LEASE_EXPIRED');
      const bytes=files.reduce((n,f)=>n+f.byteLength,0);
      const usage=db.prepare("SELECT COALESCE(SUM(total_bytes),0) AS global_bytes, COALESCE(SUM(CASE WHEN requester_provider=? AND requester_tenant=? AND requester_subject=? THEN total_bytes ELSE 0 END),0) AS own_bytes FROM plugin_result_deliveries WHERE expires_at>? AND status NOT IN ('revoked','expired')").get(row.requester.provider,row.requester.tenant,row.requester.subject,now) as any;
      if (usage.global_bytes+bytes>limits.globalBytes || usage.own_bytes+bytes>limits.principalBytes) throw new Error('RESULT_QUOTA');
      const insert=db.prepare('INSERT INTO plugin_result_files (id,delivery_id,name,byte_length,sha256,data) VALUES (?,?,?,?,?,?)');
      for (const f of files) insert.run(f.id,id,f.name,f.byteLength,f.sha256,Buffer.from(f.data));
      update("UPDATE plugin_result_deliveries SET status='ready',file_count=?,total_bytes=?,revision=revision+1,lease_until=0 WHERE id=? AND lease_token=?",files.length,bytes,id,lease);
    }).immediate(),
    fail(id,lease,code) { update("UPDATE plugin_result_deliveries SET status='failed',error_code=?,revision=revision+1,lease_until=0 WHERE id=? AND lease_token=? AND status='executing'",code,id,lease); },
    claim: (id,now) => db.transaction(() => {
      const row=get(id);
      if (!row || !['ready','sending'].includes(row.status) || row.expiresAt<=now || row.leaseUntil>now) return;
      const lease=token();
      if (!update("UPDATE plugin_result_deliveries SET status='sending',lease_token=?,lease_until=?,first_send_at=COALESCE(first_send_at,?),revision=revision+1 WHERE id=? AND revision=?",lease,now+limits.sendLeaseMs,now,id,row.revision)) return;
      return get(id);
    }).immediate(),
    owns: (id,lease,now) => { const r=get(id); return !!r && r.status==='sending' && r.leaseToken===lease && r.leaseUntil>now && r.expiresAt>now; },
    sent(id,lease,messageId) { if (!update("UPDATE plugin_result_deliveries SET status='delivered',message_id=?,revision=revision+1,lease_until=0 WHERE id=? AND lease_token=? AND status='sending'",messageId,id,lease)) throw new Error('RESULT_LEASE_EXPIRED'); },
    retry(id,lease,unknown) { update("UPDATE plugin_result_deliveries SET status=?,revision=revision+1,lease_until=0 WHERE id=? AND lease_token=? AND status='sending'",unknown?'delivery_unknown':'ready',id,lease); },
    pending(tenant,now) { return db.prepare("SELECT * FROM plugin_result_deliveries WHERE requester_tenant=? AND status IN ('ready','sending') AND lease_until<=? AND expires_at>?").all(tenant,now,now).map(r=>delivery(r)!); },
    sweep: now => db.transaction(()=> {
      for (const r of db.prepare("SELECT id FROM plugin_result_deliveries WHERE expires_at<=? AND status NOT IN ('expired','revoked')").all(now) as Array<{id:string}>) remove(r.id,'expired');
      update("UPDATE plugin_result_deliveries SET status='execution_unknown',revision=revision+1 WHERE status='executing' AND lease_until<=?",now);
      update('DELETE FROM plugin_result_oauth_states WHERE expires_at<=? OR consumed_at IS NOT NULL',now);
      update('DELETE FROM plugin_result_viewer_sessions WHERE expires_at<=?',now);
    }).immediate(),
    revoke: id => db.transaction(()=>remove(id,'revoked')).immediate(),
    files(id) { return db.prepare('SELECT id,name,byte_length AS byteLength,sha256 FROM plugin_result_files WHERE delivery_id=? ORDER BY id').all(id) as any; },
    download(id,fileId) { return (db.prepare('SELECT data FROM plugin_result_files WHERE delivery_id=? AND id=?').get(id,fileId) as {data:Buffer}|undefined)?.data; },
    putOAuthState(s) { db.prepare('INSERT INTO plugin_result_oauth_states VALUES (?,?,?,?,?,?,?,NULL)').run(s.stateHash,s.nonceHash,s.deliveryId,s.provider,s.tenant,s.redirectUri,s.expiresAt); },
    consumeOAuthState: (hash,nonce,now) => db.transaction(()=>{
      const r=db.prepare('SELECT * FROM plugin_result_oauth_states WHERE state_hash=? AND browser_nonce_hash=? AND expires_at>? AND consumed_at IS NULL').get(hash,nonce,now) as any;
      if (!r || !update('UPDATE plugin_result_oauth_states SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL',now,hash)) return;
      return {stateHash:r.state_hash,nonceHash:r.browser_nonce_hash,deliveryId:r.delivery_id,provider:r.provider,tenant:r.tenant,redirectUri:r.redirect_uri,expiresAt:r.expires_at} as PluginResultOAuthState;
    }).immediate(),
    putViewer(hash,p,expires) { db.prepare('INSERT INTO plugin_result_viewer_sessions VALUES (?,?,?,?,?)').run(hash,p.provider,p.tenant,p.subject,expires); },
    viewer(hash,now) { return db.prepare('SELECT provider,tenant,subject FROM plugin_result_viewer_sessions WHERE token_hash=? AND expires_at>?').get(hash,now) as any; }
  };
}
