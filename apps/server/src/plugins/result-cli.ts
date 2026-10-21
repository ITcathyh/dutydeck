import type { Command } from 'commander';
/** This command uses only the in-session HTTP capability, never the installation DB/token. */
export function registerPluginResultCli(program:Command) {
  const root=program.command('plugin-tool').description('Run controlled plugin exports for the original human requester');
  const request=async(path:string,turn:string,body?:unknown)=> {
    try {
      const base=process.env.dutydeck_group_tools_url,token=process.env.dutydeck_group_tools_token;
      if (!base || !token) throw new Error();
      const response=await fetch(`${base.replace(/\/$/,'')}${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'x-dutydeck-result-turn':turn,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const value=await response.json() as any;
      if (!response.ok) { const code=typeof value.error?.code==='string' && /^RESULT_[A-Z_]+$/.test(value.error.code)?value.error.code:'RESULT_UNAVAILABLE'; process.stderr.write(`${code}\n`); process.exitCode=1; return; }
      // Project the approved response shape even if a proxy returns unrelated data.
      if (body===undefined) process.stdout.write(JSON.stringify({tools:Array.isArray(value.tools)?value.tools.map((t:any)=>({id:t.id,description:t.description})):[]})+'\n');
      else if (typeof value.deliveryId==='string' && ['delivered','pending','unknown','failed'].includes(value.status) && Number.isSafeInteger(value.fileCount)) process.stdout.write(JSON.stringify({deliveryId:value.deliveryId,status:value.status,fileCount:value.fileCount})+'\n');
      else throw new Error();
    } catch { process.stderr.write('RESULT_UNAVAILABLE\n'); process.exitCode=1; }
  };
  root.command('list').requiredOption('--turn <token>','Current turn token').action(options=>request('/plugin-tools',options.turn));
  root.command('call <tool>').requiredOption('--turn <token>','Current turn token').requiredOption('--call-id <id>','Stable id for retries of this exact invocation').requiredOption('--json <input>','JSON arguments').action(async(tool:string,options)=> {
    let input:unknown;
    try { input=JSON.parse(options.json); if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9_-]*$/.test(tool)) throw new Error(); } catch { process.stderr.write('RESULT_INVALID_INPUT\n'); process.exitCode=1; return; }
    await request(`/plugin-tools/${tool}`,options.turn,{input,callId:options.callId,turn:options.turn});
  });
}
