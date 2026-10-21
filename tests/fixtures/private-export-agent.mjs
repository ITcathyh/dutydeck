import readline from 'node:readline';
import { writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);
readline.createInterface({input:process.stdin}).on('line',async line=> {
  let input; try {input=JSON.parse(line);} catch {return;}
  const prompt=input.prompt ?? '';
  appendFileSync(process.env.export_agent_log,JSON.stringify({prompt})+'\n');
  const turn=prompt.match(/plugin-tool call[\s\S]*?--turn ([A-Za-z0-9_-]+)/)?.[1];
  writeFileSync(process.env.export_agent_context,JSON.stringify({turn,url:process.env.dutydeck_group_tools_url,token:process.env.dutydeck_group_tools_token}));
  try {
    const result=await run(process.execPath,['--import',process.env.export_tsx,process.env.export_cli,'plugin-tool','call','private-export/export-report','--json','{"reportId":"weekly"}','--call-id','first-export','--turn',turn ?? 'missing'],{env:process.env,cwd:process.cwd()});
    appendFileSync(process.env.export_agent_log,JSON.stringify({stdout:result.stdout,stderr:result.stderr})+'\n');
    writeFileSync(process.env.export_agent_receipt,result.stdout);
    process.stdout.write(JSON.stringify({type:'text',text:result.stdout})+'\n');
  } catch(error) {appendFileSync(process.env.export_agent_log,JSON.stringify({stdout:error.stdout,stderr:error.stderr})+'\n');writeFileSync(process.env.export_agent_receipt,JSON.stringify({error:true}));}
  while(!existsSync(process.env.export_agent_release)) await new Promise(resolve=>setTimeout(resolve,20));
  process.stdout.write(JSON.stringify({type:'completed',stopReason:'end_turn'})+'\n');
});
