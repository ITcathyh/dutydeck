import Database from 'better-sqlite3';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig } from '@dutydeck/shared';
import { startLocalServer } from '../service.js';
import { PluginStore } from './store.js';
import { createLarkCardService } from '../lark/service.js';
import { readLarkConfig } from '../lark/config.js';
import { LarkMessageCoordinator } from '../lark/coordinator.js';
const cleanup:Array<()=>unknown|Promise<unknown>>=[];
afterEach(async()=> {for(const work of cleanup.splice(0).reverse()) await work();});
async function port() { const s=createNetServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));return p; }
async function http(handler:Parameters<typeof createServer>[0]) {const s=createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');cleanup.push(async()=>{s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));});return `http://127.0.0.1:${(s.address() as any).port}`;}
it('real plugin install, daemon, human resolver, CLI, BLOB, receipt and OAuth download keep canary out of the Agent',async()=> {
  const dir=await mkdtemp(join(tmpdir(),'dutydeck-private-export-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const canary='PRIVATE_EXPORT_CANARY_48b9eae2';let exports=0;const requests:Array<{path:string;body:any;authorization?:string}>=[];const cards:any[]=[];
  const upstream=await http(async(req,res)=> {
    const chunks:Buffer[]=[];for await(const c of req) chunks.push(Buffer.from(c));let body:any={};if(chunks.length){const raw=Buffer.concat(chunks).toString();try{body=JSON.parse(raw);}catch{body={raw};}}
    requests.push({path:req.url!,body,authorization:req.headers.authorization});res.setHeader('content-type','application/json');
    if(req.url==='/reports/weekly'){exports++;res.end(canary);return;}
    if(req.url==='/open-apis/authen/v2/oauth/token'){res.end(JSON.stringify({access_token:body.code==='alice-code'?'alice-uat':'bob-uat'}));return;}
    if(req.url==='/open-apis/authen/v1/user_info'){res.end(JSON.stringify({code:0,data:{open_id:req.headers.authorization==='Bearer alice-uat'?'ou_alice':'ou_bob'}}));return;}
    if(req.url!.includes('/chats/oc_export/members')){res.end(JSON.stringify({code:0,data:{items:[{member_id:'ou_alice',member_id_type:'open_id',name:'Alice'}],has_more:false}}));return;}
    if(req.url!.includes('/auth/')){res.end(JSON.stringify({code:0,tenant_access_token:'synthetic',expire:3600}));return;}
    if(req.method==='GET' && req.url!.includes('/im/v1/messages/om_origin')){res.end(JSON.stringify({code:0,data:{items:[{message_id:'om_origin',chat_id:'oc_export',sender:{id:'ou_alice',id_type:'open_id',sender_type:'user'},body:{content:'{"text":"export weekly report"}'},msg_type:'text'}]}}));return;}
    cards.push(body);res.end(JSON.stringify({code:0,data:{message_id:`om_card_${cards.length}`,chat_id:'oc_export'}}));
  });
  const data=join(dir,'data'),database=join(data,'state.db'),base=`http://127.0.0.1:${await port()}`;
  const store=new PluginStore(data);await store.install(resolve(import.meta.dirname,'../../../../examples/plugins/private-export'),{yes:true});await store.setConfig('private-export','source_url',Buffer.from(`${upstream}/reports/`));
  const repos=createRepositories(database,{newDatabaseAuthority:'ledger_v1'});cleanup.push(()=>repos.close());
  await repos.config.set('lark.bots',JSON.stringify([{appId:'cli_export',appSecret:'synthetic-secret',listening:true,workspace:dir,defaultAgentId:'export-agent',allowedUsers:[],allowedEmails:[],groupToolsEnabled:true,groupToolsAllowSend:true,riskControlMode:'off',permissionMode:'full-trust',fullTrustConfirmed:true,webBaseUrl:base}]));
  const log=join(dir,'agent.jsonl'),receiptPath=join(dir,'receipt.json'),contextPath=join(dir,'context.json'),release=join(dir,'release');
  const agent:AgentConfig={id:'export-agent',name:'Export',command:process.execPath,args:[resolve(import.meta.dirname,'../../../../tests/fixtures/private-export-agent.mjs')],protocol:'pipe',cwd:dir,env:{export_agent_log:log,export_agent_receipt:receiptPath,export_agent_context:contextPath,export_agent_release:release,export_cli:resolve(import.meta.dirname,'../cli.ts'),export_tsx:createRequire(import.meta.url).resolve('tsx')},permissionMode:'full-trust',timeout:90,capabilities:{pause:false,resume:true},builtin:false};
  const env={...process.env,HOME:dir,NODE_ENV:'test',DUTYDECK_DATABASE_URL:database,DUTYDECK_DEFAULT_CWD:dir,DUTYDECK_PORT:new URL(base).port,DUTYDECK_HOST:'127.0.0.1',DUTYDECK_AGENTS_JSON:JSON.stringify([agent]),DUTYDECK_DISABLE_LARK_LISTENER:'true',LARK_OPEN_API_BASE_URL:upstream,LARK_API_QPS:'1000',LARK_API_BURST:'1000',LARK_API_RETRY_MAX_ATTEMPTS:'0'};
  const server=await startLocalServer({webRoot:dir,env,pluginResultIdentity:{allowLoopback:true,accountsBase:upstream,apiBase:upstream}});cleanup.push(async()=>{await writeFile(release,'1');await server.close();});
  const bot=(await readLarkConfig(repos.config,'cli_export'))!,client=createLarkCardService(env,fetch,bot);
  const daemonLogs:any[]=[];const logger={info:(...args:any[])=>daemonLogs.push(args),warn:(...args:any[])=>daemonLogs.push(args),error:(...args:any[])=>daemonLogs.push(args)};
  const coordinator=new LarkMessageCoordinator(server.runtime,client,logger,Math.random,'ou_bot',undefined,repos.channelMappings,async()=> 'group',undefined,undefined,{store:repos.config});cleanup.push(()=>coordinator.stop());await coordinator.initializeWorkflows(bot);
  await coordinator.handle({messageId:'om_origin',chatId:'oc_export',chatType:'group',senderOpenId:'ou_alice',senderType:'user',messageType:'text',content:'{"text":"export weekly report"}',mentions:[{key:'@_user_1',name:'Bot',openId:'ou_bot'}]},bot);
  const receipt=await vi.waitFor(async()=> {const value=JSON.parse(await readFile(receiptPath,'utf8'));expect(value).toHaveProperty('deliveryId');return value;},{timeout:15_000,interval:100});
  expect(receipt).toMatchObject({status:'delivered',fileCount:1});expect(exports).toBe(1);
  const delivery=repos.pluginResults.get(receipt.deliveryId)!;expect(delivery.requester).toEqual({provider:'lark',tenant:'cli_export',subject:'ou_alice'});
  const context=JSON.parse(await readFile(contextPath,'utf8'));
  const call=(body:any)=>fetch(`${context.url}/plugin-tools/private-export/export-report`,{method:'POST',headers:{authorization:`Bearer ${context.token}`,'content-type':'application/json'},body:JSON.stringify(body)});
  expect(await (await call({input:{reportId:'weekly'},callId:'first-export',turn:context.turn})).json()).toEqual(receipt);expect(exports).toBe(1);
  expect((await call({input:{reportId:'other'},callId:'first-export',turn:context.turn})).status).toBe(409);
  expect((await call({input:{reportId:'weekly'},callId:'second',turn:'stale'})).status).toBe(403);
  expect((await call({input:{reportId:'weekly'},callId:'second'})).status).toBe(400);
  const file=repos.pluginResults.files(delivery.id)[0]!;
  for(const headers of [{},{authorization:`Bearer ${context.token}`},{authorization:'Bearer admin'},{cookie:'dutydeck_session=admin'}]) expect((await fetch(`${base}/api/plugin-results/${delivery.id}/files/${file.id}`,{headers})).status).toBe(401);
  const shell=await fetch(`${base}/plugin-results/${delivery.id}`);const html=await shell.text();expect(html).not.toContain('report.csv');const nonceCookie=shell.headers.get('set-cookie')!.split(';')[0]!,nonce=html.match(/name="nonce" value="([^"]+)"/)![1];
  expect((await fetch(`${base}/plugin-results/${delivery.id}`,{method:'HEAD'})).headers.get('set-cookie')).toBeNull();
  const start=()=>fetch(`${base}/api/plugin-results/${delivery.id}/auth/start`,{method:'POST',redirect:'manual',headers:{origin:base,cookie:nonceCookie,'content-type':'application/json'},body:JSON.stringify({nonce})});
  const login=await start();expect(login.status).toBe(303);const authUrl=new URL(login.headers.get('location')!);expect(authUrl.searchParams.get('scope')).toBeNull();expect(authUrl.searchParams.get('client_id')).toBe('cli_export');
  const callback=(state:string,code:string,cookie=nonceCookie,method='GET')=>fetch(`${base}/api/plugin-results/oauth/callback?state=${state}&code=${code}`,{method,redirect:'manual',headers:{cookie}});
  const state=authUrl.searchParams.get('state')!;
  expect((await callback(state,'alice-code','dutydeck_result_nonce=another-browser')).status).toBe(403);
  expect((await callback(state,'alice-code',nonceCookie,'HEAD')).status).toBe(405);
  const success=await callback(state,'alice-code');expect(success.status).toBe(303);const viewerCookie=success.headers.get('set-cookie')!.split(';')[0]!;expect(success.headers.get('location')).toBe(`/plugin-results/${delivery.id}`);
  expect((await callback(state,'alice-code')).status).toBe(403);
  const bobState=new URL((await start()).headers.get('location')!).searchParams.get('state')!;const bob=await callback(bobState,'bob-code');expect(bob.status).toBe(403);expect(bob.headers.get('set-cookie')).toBeNull();
  const listing=await fetch(`${base}/api/plugin-results/${delivery.id}`,{headers:{cookie:viewerCookie}});expect(await listing.json()).toMatchObject({files:[{name:'report.csv',byteLength:Buffer.byteLength(canary)}]});
  const download=await fetch(`${base}/api/plugin-results/${delivery.id}/files/${file.id}`,{headers:{cookie:viewerCookie}});expect(download.headers.get('content-type')).toBe('application/octet-stream');expect(download.headers.get('content-disposition')).toContain('attachment;');expect(await download.text()).toBe(canary);
  expect((await fetch(`${base}/api/plugin-results/${delivery.id}/files/forged`,{headers:{cookie:viewerCookie}})).status).toBe(404);
  const tokenRequest=requests.find(r=>r.path==='/open-apis/authen/v2/oauth/token')!;expect(tokenRequest.body).toEqual({grant_type:'authorization_code',code:'alice-code',client_id:'cli_export',client_secret:'synthetic-secret',redirect_uri:`${base}/api/plugin-results/oauth/callback`});
  const persisted = new Database(database, { readonly: true });
  try { const authData = JSON.stringify([...persisted.prepare('SELECT * FROM plugin_result_oauth_states').all(), ...persisted.prepare('SELECT * FROM plugin_result_viewer_sessions').all(), ...persisted.prepare('SELECT * FROM plugin_result_deliveries').all()]); expect(authData).not.toMatch(/alice-code|bob-code|alice-uat|bob-uat/); expect(authData).not.toContain(state); expect(authData).not.toContain(viewerCookie.split('=')[1]!); } finally { persisted.close(); }
  const events=await repos.events.list(delivery.sessionId);expect(JSON.stringify(events)).not.toContain(canary);expect(await readFile(log,'utf8')).not.toContain(canary);expect(JSON.stringify(cards)).not.toContain(canary);expect(JSON.stringify(daemonLogs)).not.toContain(canary);
  expect(JSON.stringify(events)).not.toContain('report.csv');expect(await readFile(log,'utf8')).not.toContain('report.csv');
  repos.pluginResults.revoke(delivery.id);expect((await fetch(`${base}/api/plugin-results/${delivery.id}/files/${file.id}`,{headers:{cookie:viewerCookie}})).status).toBe(404);expect(repos.pluginResults.download(delivery.id,file.id)).toBeUndefined();
},60_000);
