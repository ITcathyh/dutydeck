import { resolve,join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema } from '@dutydeck/shared';
import { DutydeckRuntime } from '../../src/index.js';
const directory=process.argv[2];if(!directory)throw new Error('Missing directory');
const repositories=createRepositories(join(directory,'db'),{newDatabaseAuthority:'ledger_v1'});
const bind=repositories.execution.bind.bind(repositories.execution);
repositories.execution.bind=claim=>{
 const bound=bind(claim);
 bound.confirmNativeContext=()=>{
  process.send?.({phase:'native-file-saved'},()=>process.kill(process.pid,'SIGKILL'));
  throw new Error('Crash after the first file receipt');
 };
 return bound;
};
const agent=agentConfigSchema.parse({id:'strict',name:'Strict',protocol:'acp',command:process.execPath,args:[resolve('tests/fixtures/acp-strict-native-agent.mjs')],cwd:directory,env:{native_directory:directory},permissionMode:'full-trust',timeout:10,capabilities:{pause:false,resume:true}});
const runtime=new DutydeckRuntime(repositories,{cleanupIntervalMs:0});
await runtime.initialize([agent]);
await runtime.start({agentId:agent.id}).catch(()=>{});
