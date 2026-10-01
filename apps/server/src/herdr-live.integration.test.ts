import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { startLocalServer, type LocalServer } from './service.js';
import { withoutHerdrEnvironment } from './herdr.js';
import { dutydeckGroupToolsCommand } from './lark/agent-tools.js';

const exec = promisify(execFile);
// Run after pnpm build. This opt-in test creates and cleans only its own named sessions.
describe.skipIf(process.env.DUTYDECK_TEST_HERDR !== 'true')('real Dutydeck Agent → dedicated Herdr CLI', () => {
  it('creates/reuses isolated sessions, reads a marker and preserves side tasks across daemon shutdown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-herdr-live-'));
    const allocated = createServer(); await new Promise<void>(resolve => allocated.listen(0, '127.0.0.1', resolve));
    const port = (allocated.address() as { port: number }).port;
    await new Promise<void>(resolve => allocated.close(()=>resolve()));
    const cleanEnv = withoutHerdrEnvironment(process.env);
    const native = async (args: string[]) => (await exec('herdr', args, { env: cleanEnv, timeout: 10000 })).stdout;
    const topology = async () => {
      const workspaces=JSON.parse(await native(['--session','default','workspace','list'])).result.workspaces;
      const panes=JSON.parse(await native(['--session','default','pane','list'])).result.panes;
      return {workspaces:workspaces.map((w:any)=>[w.workspace_id,w.tab_count,w.pane_count]).sort(),panes:panes.map((p:any)=>[p.pane_id,p.tab_id,p.workspace_id]).sort()};
    };
    const before = await topology();
    const agentHome=join(cwd,'agent-home'),agentConfig=join(cwd,'agent-config');
    await mkdir(agentHome);await mkdir(agentConfig);
    const names = new Set<string>();
    let server: LocalServer | undefined;
    try {
      vi.stubEnv('HERDR_SOCKET_PATH','/user/default.sock'); vi.stubEnv('HERDR_PANE_ID','user:p1'); vi.stubEnv('HERDR_ENV','1'); vi.stubEnv('HERDR_SESSION','default');
      const env = { ...process.env, DUTYDECK_HOST:'127.0.0.1',DUTYDECK_PORT:String(port),DUTYDECK_DATABASE_URL:join(cwd,'dutydeck.db'),DUTYDECK_DEFAULT_CWD:cwd,DUTYDECK_LARK_LISTEN:'false',DUTYDECK_BOT_APP_ID:undefined,
        DUTYDECK_AGENTS_JSON:JSON.stringify([{id:'herdr-fixture',name:'Herdr fixture',command:process.execPath,args:[resolve('tests/fixtures/mock-acp-agent.mjs')],protocol:'acp',cwd,env:{HOME:agentHome,XDG_CONFIG_HOME:agentConfig},permissionMode:'ask',timeout:30,capabilities:{pause:false,resume:true},builtin:false}]) };
      server=await startLocalServer({env,groupToolsCommand:dutydeckGroupToolsCommand(resolve('apps/server/dist/cli.js'))});
      const a=await server.runtime.start({agentId:'herdr-fixture'});
      const b=await server.runtime.start({agentId:'herdr-fixture'});
      const turn=async(id:string,args:string[])=>{
        const beforeEvents=await server!.runtime.getEvents(id); const after=beforeEvents.at(-1)?.sequence ?? 0;
        const result=await server!.runtime.send(id,`herdr command: ${JSON.stringify(args)}`);
        expect(result.status, JSON.stringify({args,events:(await server!.runtime.getEvents(id,after)).filter(event=>event.type==='error'||event.type==='text').map(event=>event.data)})).toBe('completed');
        return (await server!.runtime.getEvents(id,after)).filter(event=>event.type==='text'&&(event.data as any)?.role!=='user').map(event=>(event.data as any).text).join('');
      };
      const sa=JSON.parse(await turn(a.id,['prepare']));names.add(sa.session_name);
      const sb=JSON.parse(await turn(b.id,['prepare']));names.add(sb.session_name);
      expect(sb.session_name).not.toBe(sa.session_name);
      expect(JSON.parse(await turn(a.id,['prepare']))).toEqual(sa);
      const split=JSON.parse(await turn(a.id,['pane','split',sa.root_pane_id,'--direction','right','--cwd',cwd,'--no-focus']));
      const worker=split.result.pane.pane_id;
      await turn(a.id,['pane','run',worker,"printf 'DUTYDECK_HERDR_LIVE_MARKER\\n'; sleep 60"]);
      await turn(a.id,['pane','wait-output',worker,'--regex','^DUTYDECK_HERDR_LIVE_MARKER$','--timeout','5000']);
      expect((await turn(a.id,['pane','read',worker,'--source','recent-unwrapped','--lines','40'])).split(/\r?\n/).map(line=>line.trim())).toContain('DUTYDECK_HERDR_LIVE_MARKER');
      expect(JSON.parse(await turn(a.id,['prepare']))).toEqual(sa);
      await server.close(); server=undefined;
      expect((await native(['--session',sa.session_name,'pane','read',worker,'--lines','40'])).split(/\r?\n/).map(line=>line.trim())).toContain('DUTYDECK_HERDR_LIVE_MARKER');
      const running=JSON.parse(await native(['--session',sa.session_name,'pane','process-info','--pane',worker]));
      expect(JSON.stringify(running)).toContain('sleep');
      server=await startLocalServer({env,groupToolsCommand:dutydeckGroupToolsCommand(resolve('apps/server/dist/cli.js'))});
      expect(JSON.parse(await turn(a.id,['prepare']))).toEqual(sa);
      expect(JSON.parse(await turn(b.id,['stop']))).toEqual({session_name:sb.session_name,stopped:true});
      expect(await native(['--session',sa.session_name,'workspace','list'])).toContain(sa.workspace_id);
      expect(await topology()).toEqual(before);
      console.log(JSON.stringify({herdr_live:{sessions:[sa.session_name,sb.session_name],root:sa.root_pane_id,worker,marker:true,reused:true,daemon_shutdown_survived:true,default_topology_unchanged:true}}));
    } finally {
      if(server) await server.close();
      const states=JSON.parse(await native(['session','list','--json'])).sessions;
      for(const name of names) {
        if(states.find((session:any)=>session.name===name)?.running) await native(['session','stop',name,'--json']);
        await native(['session','delete',name,'--json']);
      }
      vi.unstubAllEnvs(); await rm(cwd,{recursive:true,force:true});
    }
  }, 120000);
});
