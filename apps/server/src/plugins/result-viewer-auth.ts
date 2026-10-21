import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PluginResultDelivery, PluginResultRepository, ResultPrincipal } from '@dutydeck/shared';
import { PluginResultError, resultHash, resultToken, resultAuthorizationRevoked } from './result-service.js';
import type { PluginResultIdentity } from '../lark/plugin-result-identity.js';
export interface PluginResultViewerOptions {
  repository: PluginResultRepository; identity: PluginResultIdentity;
  authorize(delivery: PluginResultDelivery): Promise<void>;
  now?: () => number;
}
const samePrincipal=(a:ResultPrincipal,b:ResultPrincipal)=>a.provider===b.provider && a.tenant===b.tenant && a.subject===b.subject;
const cookie=(r:FastifyRequest,name:string)=>r.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${name}=`))?.slice(name.length+1);
const safe=(reply:FastifyReply)=>reply.header('cache-control','no-store').header('referrer-policy','no-referrer').header('x-content-type-options','nosniff');
export function registerPluginResultViewer(app:FastifyInstance,options:PluginResultViewerOptions) {
  const now=options.now ?? Date.now, repo=options.repository;
  const valid=async(id:string)=> {
    const row=repo.get(id);
    if (!row || row.expiresAt<=now() || !['ready','sending','delivered','delivery_unknown'].includes(row.status)) throw new PluginResultError('RESULT_UNAVAILABLE',404);
    try { await options.authorize(row); } catch (error) { if (resultAuthorizationRevoked(error)) repo.revoke(id); throw error; }
    const fresh=repo.get(id);
    if (!fresh || fresh.expiresAt<=now() || ['expired','revoked'].includes(fresh.status)) throw new PluginResultError('RESULT_UNAVAILABLE',404);
    return fresh;
  };
  const viewer=async(request:FastifyRequest,id:string)=> {
    const row=await valid(id), token=cookie(request,'dutydeck_result_viewer');
    const p=token ? repo.viewer(resultHash(token),now()):undefined;
    if (!p || !samePrincipal(p,row.requester)) throw new PluginResultError('RESULT_LOGIN_REQUIRED',401);
    return row;
  };
  const route=(handler:(request:any,reply:FastifyReply)=>unknown)=>async(request:FastifyRequest,reply:FastifyReply)=> {
    safe(reply);
    try { return await handler(request,reply); } catch(error) { const e=error instanceof PluginResultError?error:new PluginResultError('RESULT_UNAVAILABLE',403); return reply.code(e.statusCode).send({error:{code:e.code}}); }
  };
  const cookieHeader=(name:string,value:string,path:string,seconds:number,redirect:string)=>`${name}=${value}; Path=${path}; Max-Age=${seconds}; HttpOnly; SameSite=Lax${new URL(redirect).protocol==='https:'?'; Secure':''}`;
  app.get<{Params:{deliveryId:string}}>('/plugin-results/:deliveryId',{logLevel:'silent'},route(async(request,reply)=> {
    // Public login shell; HEAD must neither issue cookies nor start a login.
    if (request.method==='HEAD') return reply.type('text/html').send('');
    const nonce=resultToken();
    let secure=true;
    try { const r=repo.get(request.params.deliveryId); if (r) secure=new URL(await options.identity.redirectUri(r.requester.tenant)).protocol==='https:'; } catch {}
    reply.header('set-cookie',`dutydeck_result_nonce=${nonce}; Path=/api/plugin-results; Max-Age=300; HttpOnly; SameSite=Lax${secure?'; Secure':''}`);
    const id=encodeURIComponent(request.params.deliveryId).replace(/'/g,'%27');
    const scriptNonce=resultToken();
    reply.header('content-security-policy',`default-src 'none'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>受控插件结果</title><body><h1>受控插件结果</h1><p>仅原请求者可通过飞书登录查看；结果 24 小时后过期。</p><form method="post" action="/api/plugin-results/${id}/auth/start"><input type="hidden" name="nonce" value="${nonce}"><button>使用飞书登录</button></form><ul id="files"></ul><script nonce="${scriptNonce}">fetch('/api/plugin-results/${id}').then(r=>r.ok?r.json():null).then(v=>{if(!v)return;for(const f of v.files){const li=document.createElement('li'),a=document.createElement('a');a.textContent=f.name+' ('+f.byteLength+' bytes)';a.href=f.url;li.append(a);document.getElementById('files').append(li);}}).catch(()=>{});</script></body></html>`);
  }));
  // Native browser forms use URL encoding; JSON clients must still prove Origin and nonce.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) app.addContentTypeParser('application/x-www-form-urlencoded',{parseAs:'string'},(_request,body,done)=>done(null,Object.fromEntries(new URLSearchParams(body as string))));
  app.post('/api/plugin-results/:deliveryId/auth/start',{logLevel:'silent'},route(async(request,reply)=> {
    const row=await valid(request.params.deliveryId), redirect=await options.identity.redirectUri(row.requester.tenant);
    const origin=request.headers.origin;
    const nonce=cookie(request,'dutydeck_result_nonce');
    if (origin!==new URL(redirect).origin || typeof nonce!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || request.body?.nonce!==nonce) throw new PluginResultError('RESULT_CSRF',403);
    const state=resultToken();
    const location=await options.identity.authorize(row.requester.tenant,redirect,state);
    repo.putOAuthState({stateHash:resultHash(state),nonceHash:resultHash(nonce),deliveryId:row.id,provider:row.requester.provider,tenant:row.requester.tenant,redirectUri:redirect,expiresAt:now()+300_000});
    return reply.code(303).header('location',location).send();
  }));
  app.get('/api/plugin-results/oauth/callback',{logLevel:'silent'},route(async(request,reply)=> {
    if (request.method==='HEAD') return reply.code(405).send();
    const state=request.query?.state,code=request.query?.code,nonce=cookie(request,'dutydeck_result_nonce');
    if (typeof state!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(state) || typeof code!=='string' || !code || code.length>4096 || !nonce) throw new PluginResultError('RESULT_LOGIN_FAILED');
    const pending=repo.consumeOAuthState(resultHash(state),resultHash(nonce),now());
    if (!pending) throw new PluginResultError('RESULT_LOGIN_FAILED');
    const row=await valid(pending.deliveryId);
    if (row.requester.provider!==pending.provider || row.requester.tenant!==pending.tenant) throw new PluginResultError('RESULT_LOGIN_FAILED');
    const principal=await options.identity.exchange(pending.tenant,pending.redirectUri,code);
    if (!samePrincipal(principal,row.requester)) throw new PluginResultError('RESULT_LOGIN_FAILED');
    await valid(row.id);
    const token=resultToken();
    repo.putViewer(resultHash(token),principal,now()+30*60_000);
    reply.header('set-cookie',cookieHeader('dutydeck_result_viewer',token,'/api/plugin-results',1800,pending.redirectUri));
    return reply.code(303).header('location',`/plugin-results/${row.id}`).send();
  }));
  app.get('/api/plugin-results/:deliveryId',{logLevel:'silent'},route(async(request,reply)=> {
    const row=await viewer(request,request.params.deliveryId);
    if (request.method==='HEAD') return reply.send();
    return {files:repo.files(row.id).map(f=>({id:f.id,name:f.name,byteLength:f.byteLength,url:`/api/plugin-results/${row.id}/files/${f.id}`}))};
  }));
  app.get('/api/plugin-results/:deliveryId/files/:fileId',{logLevel:'silent'},route(async(request,reply)=> {
    const row=await viewer(request,request.params.deliveryId);
    const file=repo.files(row.id).find(f=>f.id===request.params.fileId);
    if (!file) throw new PluginResultError('RESULT_UNAVAILABLE',404);
    reply.type('application/octet-stream').header('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}`).header('content-length',file.byteLength);
    if (request.method==='HEAD') return reply.send();
    const data=repo.download(row.id,file.id);
    if (!data) throw new PluginResultError('RESULT_UNAVAILABLE',404);
    return reply.send(Buffer.from(data));
  }));
}
