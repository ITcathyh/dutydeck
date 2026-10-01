import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec=promisify(execFile);
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture() {
  const cwd=await mkdtemp(join(tmpdir(),'dutydeck-herdr-cli-'));cleanup.push(()=>rm(cwd,{recursive:true,force:true}));
  const binary=join(cwd,'herdr'),socket=join(cwd,'owned.sock');
  await writeFile(binary,`#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),herdr:Object.fromEntries(Object.entries(process.env).filter(([key])=>/^HERDR_/i.test(key))),home:process.env.HOME,config:process.env.XDG_CONFIG_HOME}));\n`);await chmod(binary,0o755);
  const requests:any[]=[];
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    requests.push({url:request.url,authorization:request.headers.authorization,body:JSON.parse(Buffer.concat(chunks).toString())});
    response.setHeader('content-type','application/json');response.end(JSON.stringify({session_name:'dutydeck-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',socket_path:socket,binary,workspace_id:'w1',root_pane_id:'w1:p1'}));
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanup.push(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const env={...process.env,HOME:join(cwd,'different-home'),XDG_CONFIG_HOME:join(cwd,'different-config'),HERDR_SOCKET_PATH:'/user/default.sock',HERDR_SESSION:'default',HERDR_ENV:'1',HERDR_PANE_ID:'user:p1',HERDR_CUSTOM:'outer',dutydeck_relay_url:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/relay`,dutydeck_relay_token:'fixture-token'};
  const invoke=(args:string[])=>exec(process.execPath,['--import','tsx',resolve('apps/server/src/cli.ts'),'session','herdr','--',...args],{env,cwd:process.cwd()});
  return {invoke,requests,socket,env};
}
describe('real session herdr CLI boundary',()=>{
  it('uses only the verified socket across different HOME/XDG_CONFIG_HOME, and preserves Herdr arguments',async()=>{
    const h=await fixture();
    const args=['pane','read','w1:p1','--source','recent-unwrapped','--lines','40'];
    const result=await h.invoke(args);expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({args,herdr:{HERDR_SOCKET_PATH:h.socket},home:h.env.HOME,config:h.env.XDG_CONFIG_HOME});
    expect(h.requests).toEqual([{url:'/api/relay/sessions/self/herdr',authorization:'Bearer fixture-token',body:{action:'prepare'}}]);
  });
  it.each([['workspace','list','--session','default'],['workspace','list','--machine=other'],['workspace','list','--remote','host'],['server','stop'],['session','stop','default'],['pane','split','--current'],['workspace','list','--','--session','default']])('rejects scope changes before HTTP %j',async(...args)=>{
    const h=await fixture();let error:any;
    try{await h.invoke(args);}catch(caught){error=caught;}
    expect(error?.code).toBe(2);expect(h.requests).toEqual([]);
  });
});
