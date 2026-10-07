import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayAskBroker, RelayCapabilityRegistry } from '@dutydeck/relay';
import { HerdrSessions, withoutHerdrEnvironment } from './herdr.js';
import { validateHerdrArguments } from './herdr-cli.js';
import { createCliProgram } from './cli-program.js';
import { buildApp } from './app.js';

const dirs: string[] = [];
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const stop of close.splice(0)) await stop(); for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }); vi.restoreAllMocks(); });
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-herdr-test-')); dirs.push(cwd);
  const binary = join(cwd, 'herdr');
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), name = args[1], command = args.slice(2);
if (args[0] !== '--session' || !/^dutydeck-[a-f0-9]{32}$/.test(name)) process.exit(9);
fs.appendFileSync(path.join(__dirname, 'calls'), JSON.stringify({args, herdr:Object.keys(process.env).filter(k=>k.startsWith('HERDR_'))})+'\\n');
const state=path.join(__dirname,name);
const ok=result=>console.log(JSON.stringify({result}));
const fail=code=>{console.error(JSON.stringify({error:{code,message:code}}));process.exit(1)};
if(command[0]==='server') {fs.writeFileSync(state,'[]'); setInterval(()=>{},1000);fs.writeFileSync(state+'.pid',String(process.pid));}
else if(command.join(' ')==='session stop '+name+' --json') {if(fs.existsSync(state+'.pid'))process.kill(Number(fs.readFileSync(state+'.pid')));fs.rmSync(state,{force:true});ok({});}
else if(command.join(' ')==='session list --json') console.log(JSON.stringify({sessions:[{name,default:false,running:fs.existsSync(state),socket_path:state+'.sock'}]}));
else if(!fs.existsSync(state)) fail(fs.existsSync(path.join(__dirname,'broken'))?'permission_denied':'server_not_running');
else if(command.join(' ')==='workspace list') ok({workspaces:JSON.parse(fs.readFileSync(state))});
else if(command[0]==='workspace' && command[1]==='create') {fs.writeFileSync(state,JSON.stringify([{workspace_id:'w1'}]));ok({workspace:{workspace_id:'w1'},root_pane:{pane_id:'w1:p1'}});}
else if(command[0]==='pane') ok({panes:[{pane_id:'w1:p1'}]});
else fail('unexpected');
`);
  await chmod(binary, 0o755);
  const env = { PATH: cwd, HOME: process.env.HOME, HERDR_SOCKET_PATH: '/user/default.sock', HERDR_PANE_ID: 'user:p1', HERDR_ENV: '1' };
  const options = { database: join(cwd, 'dutydeck.db'), signingSecret: 'fixture-secret', command: "'/node' '/runtime/cli.js'", env };
  return { cwd, options, manager: new HerdrSessions(options), session: { id: 'chat-a', cwd } };
}

describe('dedicated Herdr sessions', () => {
  it('uses stable installation/bot/chat names and snake_case environment', async () => {
    const h = await fixture();
    expect(new HerdrSessions(h.options).nameFor('chat-a')).toBe(h.manager.nameFor('chat-a'));
    for (const other of [new HerdrSessions({...h.options,database:join(h.cwd,'other.db')}),new HerdrSessions({...h.options,botAppId:'other-bot'}),new HerdrSessions({...h.options,signingSecret:'other-install'})]) expect(other.nameFor('chat-a')).not.toBe(h.manager.nameFor('chat-a'));
    expect(h.manager.nameFor('chat-b')).not.toBe(h.manager.nameFor('chat-a'));
    expect(h.manager.environmentFor('chat-a')).toEqual({ dutydeck_herdr_session:h.manager.nameFor('chat-a'), dutydeck_herdr_command:"'/node' '/runtime/cli.js' session herdr --" });
    expect(h.manager.prompt()).toContain('外部 ACP/tmux');
    expect(withoutHerdrEnvironment(h.options.env)).toEqual({PATH:h.cwd,HOME:process.env.HOME});
    expect(h.options.env.HERDR_ENV).toBe('1');
  });
  it('serializes concurrent first prepare, reuses IDs across managers and stops only its named server', async () => {
    const h = await fixture(); close.push(() => h.manager.stop(h.session.id));
    const [a,b,c] = await Promise.all([h.manager.prepare(h.session),h.manager.prepare(h.session),h.manager.prepare(h.session)]);
    expect(a).toEqual(b); expect(b).toEqual(c);
    expect(await new HerdrSessions(h.options).prepare(h.session)).toEqual(a);
    const calls = (await readFile(join(h.cwd,'calls'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(calls.filter(call=>call.args[2]==='server')).toHaveLength(1);
    expect(calls.filter(call=>call.args[2]==='workspace'&&call.args[3]==='create')).toHaveLength(1);
    expect(calls.every(call=>call.args[1]===a.session_name && call.herdr.length===0)).toBe(true);
  });
  it('does not launch or fall back after a non-missing server error, and can retry after failure', async () => {
    const h=await fixture(); await writeFile(join(h.cwd,'broken'),'1');
    await expect(h.manager.prepare(h.session)).rejects.toMatchObject({code:'permission_denied'});
    expect(await readFile(join(h.cwd,'calls'),'utf8')).not.toContain('server"');
    await rm(join(h.cwd,'broken')); close.push(()=>h.manager.stop(h.session.id));
    expect(await h.manager.prepare(h.session)).toMatchObject({workspace_id:'w1',root_pane_id:'w1:p1'});
  });
  it('keeps missing Herdr optional and returns an explicit unavailable error', async () => {
    const manager = new HerdrSessions({database:'/tmp/no-herdr.db',signingSecret:'fixture',command:'/runtime/cli',env:{PATH:'/nonexistent'}});
    expect(manager.prompt()).toBe('');
    await expect(manager.prepare({id:'chat',cwd:'/tmp'})).rejects.toMatchObject({code:'HERDR_UNAVAILABLE'});
  });
});

describe('Herdr command boundary', () => {
  it.each([['--session','default','pane','list'],['workspace','list','--session=default'],['workspace','list','--','--session','default'],['workspace','list','--remote','host'],['agent','list','--machine=other'],['session','stop','default'],['server','stop'],['pane','split'],['pane','layout','--current'],['tab','create'],['pane','split','w1:p1','--env','HERDR_SOCKET_PATH=/user.sock']])('rejects unsafe arguments %j', (...args) => { expect(()=>validateHerdrArguments(args)).toThrow(); });
  it.each([['prepare'],['stop'],['pane','split','w1:p1','--direction','right','--no-focus'],['pane','read','w1:p1'],['agent','start','worker','--pane','w1:p2','--kind','codex','--','--yolo'],['agent','prompt','worker','echo --session default'],['workspace','list'],['tab','create','--workspace','w1']])('allows scoped arguments %j', (...args)=>{expect(()=>validateHerdrArguments(args)).not.toThrow();});
  it('preserves Herdr flags through Commander, including flags also defined on Dutydeck', async () => {
    const calls:string[][]=[];
    const program=createCliProgram('test',{sessionHerdr:args=>{calls.push(args);}});
    await program.parseAsync(['node','dutydeck','session','herdr','--','pane','split','w1:p1','--cwd','/work','--no-focus','--session=default']);
    expect(calls).toEqual([['pane','split','w1:p1','--cwd','/work','--no-focus','--session=default']]);
  });
  it('authenticates scope with existing session credentials and never accepts a caller-selected session', async () => {
    const h=await fixture(); const session={...h.session,state:'idle',agentId:'fixture',runId:'run',createdAt:'now',updatedAt:'now'};
    const runtime={getSession:async()=>session,subscribe:()=>()=>{}};
    const capabilities=new RelayCapabilityRegistry({get:async(id)=>id===session.id?session:undefined},'http://localhost','test');
    const app=await buildApp(runtime as any,{auth:{mode:'token',getToken:async()=> 'access',localOnly:false},relay:{runtime:runtime as any,capabilities,broker:new RelayAskBroker({publish:async()=>{}}),herdr:h.manager}});
    close.push(()=>app.close()); close.push(()=>h.manager.stop(session.id));
    expect((await app.inject({method:'POST',url:'/api/relay/sessions/self/herdr',payload:{action:'prepare'},remoteAddress:'203.0.113.1'})).statusCode).toBe(401);
    const headers={authorization:`Bearer ${capabilities.tokenFor(session.id)}`};
    expect((await app.inject({method:'POST',url:'/api/relay/sessions/other/herdr',headers,payload:{action:'prepare'},remoteAddress:'203.0.113.1'})).statusCode).toBe(401);
    const response=await app.inject({method:'POST',url:'/api/relay/sessions/self/herdr',headers,payload:{action:'prepare',session_name:'default'},remoteAddress:'203.0.113.1'});
    expect(response.statusCode).toBe(200); expect(response.json().session_name).toBe(h.manager.nameFor(session.id));
    const invalid=await app.inject({method:'POST',url:'/api/relay/sessions/self/herdr',headers,payload:{action:'run',command:'server stop'}});
    expect(invalid.statusCode).toBe(400);
  });
});
