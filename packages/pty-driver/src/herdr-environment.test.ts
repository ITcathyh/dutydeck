import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PtyBackend, TmuxBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

const dirs: string[]=[];
const drivers: PtyCliDriver[]=[];
afterEach(async()=>{await Promise.allSettled(drivers.splice(0).map(driver=>driver.stop()));vi.unstubAllEnvs();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
describe('Herdr environment at real PTY launch',()=>{
  it.each(['pty','tmux'] as const)('removes inherited and configured fake Herdr identity from %s children',async kind=>{
    const cwd=mkdtempSync(join(tmpdir(),'dutydeck-herdr-pty-'));dirs.push(cwd);
    vi.stubEnv('TMUX_TMPDIR',cwd);
    for(const [key,value] of Object.entries({HERDR_SOCKET_PATH:'/user/default.sock',HERDR_ENV:'1',HERDR_PANE_ID:'user:p1',HERDR_TAB_ID:'user:t1',HERDR_WORKSPACE_ID:'user',HERDR_SESSION:'default',HERDR_CUSTOM:'outer'}))vi.stubEnv(key,value);
    const output=join(cwd,'env.json'),script=join(cwd,'cli.mjs');
    writeFileSync(script,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(output)},JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key])=>/^HERDR_/i.test(key)||key.startsWith('dutydeck_herdr_')))));process.stdout.write('READY\\n');setInterval(()=>{},1000);`);
    const env={dutydeck_herdr_session:'dutydeck-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',dutydeck_herdr_command:"'/node' '/runtime/cli.js' session herdr --",HERDR_PANE_ID:'fake:p1'};
    const driver=new PtyCliDriver({agent:{id:'fixture',name:'Fixture',command:process.execPath,args:[],protocol:'pty-cli',cwd,env,permissionMode:'ask',timeout:10,capabilities:{pause:false,resume:true},builtin:false},adapter:{id:'fixture',capabilities:{resume:true},buildArgs:()=>[script],writeInput:()=>{},completionPattern:/DONE/},backend:kind==='tmux'?new TmuxBackend(`dd-herdr-${process.pid}`,{ownerId:'herdr-test'}):new PtyBackend(),onEvent:()=>{},onExit:()=>{},sessionId:'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'});
    drivers.push(driver);await driver.start();
    await expect.poll(()=>JSON.parse(readFileSync(output,'utf8'))).toEqual({dutydeck_herdr_session:env.dutydeck_herdr_session,dutydeck_herdr_command:env.dutydeck_herdr_command});
    expect(process.env.HERDR_PANE_ID).toBe('user:p1');
  });
});
