import readline from 'node:readline';
import { appendFileSync,existsSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir=process.env.native_directory;
const path=join(dir,'native-state.json');
const log=(method,extra={})=>appendFileSync(join(dir,'native-calls.jsonl'),JSON.stringify({method,...extra})+'\n');
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
const reply=(id,result)=>send({jsonrpc:'2.0',id,result});
const error=(id,message)=>send({jsonrpc:'2.0',id,error:{code:-32603,message}});
const state=()=>JSON.parse(readFileSync(path,'utf8'));
const config=s=>[{type:'select',id:'model',name:'Model',category:'model',currentValue:s.model,options:[{value:'A',name:'A'},{value:'B',name:'B'}]},{type:'select',id:'reasoning_effort',name:'Effort',category:'thought_level',currentValue:s.effort,options:[{value:'low',name:'low'},{value:'high',name:'high'}]}];
log('spawn',{pid:process.pid,env:process.env.dutydeck_group_tools_token});
const host=new Map();
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const {id,method,params={}}=JSON.parse(line);
 if(!method&&host.has(id)){host.get(id)();host.delete(id);return;}
 log(method,{params});
 if(method==='initialize')return reply(id,{protocolVersion:params.protocolVersion,agentCapabilities:{loadSession:process.env.native_no_load!=='1'},authMethods:[]});
 if(method==='session/new') {
  const s={id:'native-'+Date.now(),model:'A',effort:'low'};writeFileSync(path,JSON.stringify(s));
  writeFileSync(join(dir,'new-entered'),'1');while(existsSync(join(dir,'hold-new')))await new Promise(r=>setTimeout(r,5));
  return reply(id,{sessionId:s.id,configOptions:config(s)});
 }
 if(method==='session/load') {
  if(process.env.native_load_fail==='1'||!existsSync(path)||params.sessionId!==state().id)return error(id,'resource not found');
  return reply(id,process.env.native_load_no_config==='1'?{}:{configOptions:config(state())});
 }
 if(method==='session/set_config_option') {
  const s=state();s[params.configId==='model'?'model':'effort']=params.value;writeFileSync(path,JSON.stringify(s));
  writeFileSync(join(dir,'config-entered'),'1');while(existsSync(join(dir,'hold-config')))await new Promise(r=>setTimeout(r,5));
  if(existsSync(join(dir,'fail-config')))return error(id,'native changed but ACK lost');
  return reply(id,{configOptions:config(s)});
 }
 if(method==='session/prompt') {
  if(existsSync(join(dir,'fail-prompt')))return error(id,'resource not found');
  if(params.prompt.some(p=>p.text==='terminal'))await new Promise(resolve=>{host.set('terminal',resolve);send({jsonrpc:'2.0',id:'terminal',method:'terminal/create',params:{sessionId:params.sessionId,command:process.execPath,args:['-e','setInterval(()=>{},1000)']}});});
  const s=state();send({jsonrpc:'2.0',method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({model:s.model,effort:s.effort})}}}});return reply(id,{stopReason:'end_turn'});
 }
 if(method==='session/cancel')return;
 if(id!==undefined)return error(id,'Unsupported method');
});
