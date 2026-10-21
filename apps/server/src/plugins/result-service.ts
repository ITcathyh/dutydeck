import { createHash, randomBytes } from 'node:crypto';
import { canonicalExecutionJson, pluginResultLimits as limits, type PluginResultDelivery, type PluginResultRepository, type PluginResultReceipt, type ResultPrincipal, type PluginResultTarget } from '@dutydeck/shared';
import { PluginResultToolRegistry } from './result-tools.js';
export class PluginResultError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 403) { super(code); }
}
export const resultHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const resultToken = () => randomBytes(32).toString('base64url');
export interface PluginResultAuthority {
  requester: ResultPrincipal; sessionId: string; runId: string; taskId: string; attemptId: string;
  target: PluginResultTarget; cwd: string; assertCurrent(): Promise<void>;
}
export interface PluginResultAdapter {
  resolveRequester(token: string | undefined, turn: string | undefined): Promise<PluginResultAuthority>;
  assertDeliveryAuthorized(delivery: PluginResultDelivery): Promise<void>;
  deliverReceipt(delivery: PluginResultDelivery, beforeSend: () => Promise<void>, recoverOnly: boolean): Promise<string | undefined>;
}
export const resultAuthorizationRevoked = (error: unknown) => error instanceof PluginResultError && ['RESULT_PERMISSION_DENIED','RESULT_TURN_EXPIRED','RESULT_REQUESTER_REQUIRED','RESULT_ORIGIN_REQUIRED','RESULT_TOOL_UNAVAILABLE'].includes(error.code);
export const receiptFor = (r: PluginResultDelivery): PluginResultReceipt => ({ deliveryId: r.id,
  status: r.status === 'delivered' ? 'delivered' : ['execution_unknown','delivery_unknown'].includes(r.status) ? 'unknown' : ['failed','expired','revoked'].includes(r.status) ? 'failed' : 'pending', fileCount: r.fileCount });
function resultFiles(value: unknown) {
  const invalid = () => { throw new PluginResultError('RESULT_INVALID_OUTPUT', 400); };
  if (!value || typeof value !== 'object' || Object.keys(value).join(',') !== 'files') return invalid();
  const files = (value as { files: unknown }).files;
  if (!Array.isArray(files) || !files.length || files.length > limits.files) return invalid();
  let total = 0;
  return files.map(file => {
    if (!file || typeof file !== 'object' || Object.keys(file).sort().join(',') !== 'data,name' || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 160 || ['.','..'].includes(file.name) || /[\\/\u0000-\u001f\u007f]/.test(file.name) || !(file.data instanceof Uint8Array) || file.data.byteLength > limits.fileBytes) return invalid();
    const data = Buffer.from(file.data);
    total += data.byteLength;
    if (total > limits.callBytes) return invalid();
    return { id: resultToken(), name: file.name, data, byteLength: data.byteLength, sha256: resultHash(data) };
  });
}
export class PluginResultService {
  constructor(readonly repository: PluginResultRepository, readonly registry: PluginResultToolRegistry, readonly adapter: PluginResultAdapter, private readonly now = Date.now) {}
  async list(token?: string, turn?: string) {
    const authority = await this.adapter.resolveRequester(token, turn);
    await authority.assertCurrent();
    return { tools: this.registry.list({ botAppId: authority.requester.tenant, cwd: authority.cwd }) };
  }
  async call(toolId: string, input: unknown, callId: string, token?: string, turn?: string): Promise<PluginResultReceipt> {
    try { return await this.execute(toolId,input,callId,token,turn); }
    catch (error) { if (error instanceof PluginResultError) throw error; throw new PluginResultError(error instanceof Error && ['RESULT_CALL_CONFLICT','RESULT_BUSY','RESULT_QUOTA'].includes(error.message) ? error.message : 'RESULT_UNAVAILABLE', error instanceof Error && error.message==='RESULT_CALL_CONFLICT' ? 409 : 503); }
  }
  private async execute(toolId: string, input: unknown, callId: string, token?: string, turn?: string) {
    if (typeof callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(callId)) throw new PluginResultError('RESULT_INVALID_CALL_ID',400);
    const authority = await this.adapter.resolveRequester(token,turn);
    const entry = this.registry.get(toolId,{ botAppId: authority.requester.tenant, cwd: authority.cwd });
    if (!entry) throw new PluginResultError('RESULT_TOOL_UNAVAILABLE',404);
    let parsed: unknown, inputDigest: string;
    try { inputDigest=resultHash(canonicalExecutionJson(input)); parsed=entry.tool.inputSchema.parse(input); } catch { throw new PluginResultError('RESULT_INVALID_INPUT',400); }
    await authority.assertCurrent();
    const now=this.now(), id=resultToken();
    const reserved=this.repository.reserve({ id, requester:authority.requester, plugin:entry.plugin,tool:entry.tool.name,
      sessionId:authority.sessionId,runId:authority.runId,taskId:authority.taskId,attemptId:authority.attemptId,callId,inputDigest,
      target:authority.target,leaseToken:resultToken(),leaseUntil:now+limits.executionMs,providerKey:`private_${resultHash(id+canonicalExecutionJson(authority.target)).slice(0,40)}`,createdAt:now,expiresAt:now+limits.ttlMs },now);
    if (!reserved.acquired) { if (reserved.delivery.status==='ready') await this.deliver(reserved.delivery.id,authority.assertCurrent); return receiptFor(this.repository.get(reserved.delivery.id)!); }
    const row=reserved.delivery, abort=new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await authority.assertCurrent();
      const value = await Promise.race([Promise.resolve().then(()=>entry.tool.execute(parsed,{ invocationId:row.id,requester:Object.freeze({...authority.requester}),signal:abort.signal })),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new PluginResultError('RESULT_TIMEOUT',504));},limits.executionMs);})]);
      const files=resultFiles(value);
      await authority.assertCurrent();
      this.repository.store(row.id,row.leaseToken,files,this.now());
    } catch (error) {
      this.repository.fail(row.id,row.leaseToken,error instanceof PluginResultError ? error.code : 'RESULT_EXECUTION_FAILED');
      return receiptFor(this.repository.get(row.id)!);
    } finally { if (timer) clearTimeout(timer); abort.abort(); }
    await this.deliver(row.id,authority.assertCurrent);
    return receiptFor(this.repository.get(row.id)!);
  }
  async deliver(id: string, assertCurrent?: () => Promise<void>) {
    const row=this.repository.claim(id,this.now());
    if (!row) return;
    try {
      const guard=async()=>{ if (!this.registry.get(`${row.plugin}/${row.tool}`, { botAppId: row.requester.tenant, cwd: String(row.target.cwd ?? '') })) throw new PluginResultError('RESULT_TOOL_UNAVAILABLE'); await this.adapter.assertDeliveryAuthorized(row); await assertCurrent?.(); if (!this.repository.owns(row.id,row.leaseToken,this.now())) throw new PluginResultError('RESULT_LEASE_EXPIRED'); };
      await guard();
      const confirmed=await this.adapter.deliverReceipt(row,guard,true);
      if (confirmed) { this.repository.sent(row.id,row.leaseToken,confirmed); return; }
      if (this.now()-(row.firstSendAt ?? 0)>limits.retryMs) { this.repository.retry(row.id,row.leaseToken,true); return; }
      await guard();
      const beforeSend=async()=>{ await guard(); if (this.now()-(row.firstSendAt ?? 0)>limits.retryMs) throw new PluginResultError('RESULT_DELIVERY_WINDOW_EXPIRED'); };
      const messageId=await this.adapter.deliverReceipt(row,beforeSend,false);
      if (!messageId) throw new PluginResultError('RESULT_DELIVERY_PENDING');
      this.repository.sent(row.id,row.leaseToken,messageId);
    } catch (error) { if (resultAuthorizationRevoked(error)) this.repository.revoke(row.id); else this.repository.retry(row.id,row.leaseToken,false); }
  }
  async sweep(tenants: string[]) { this.repository.sweep(this.now()); for (const tenant of tenants) for (const row of this.repository.pending(tenant,this.now())) await this.deliver(row.id); }
}
