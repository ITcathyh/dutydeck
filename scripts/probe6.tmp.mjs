import { createRequire } from 'node:module';
const REPO='/data00/home/huangyuhang.edu/ai/dockmux';
const req = createRequire(`${REPO}/package.json`);
const { register } = await import(`file://${req.resolve('tsx/esm/api')}`);
register();
const C = await import(`${REPO}/apps/server/src/lark/commands.ts`);
const A = await import(`${REPO}/apps/server/src/lark/card-actions.ts`);
const S = await import(`${REPO}/apps/server/src/lark/service.ts`);
const full = { getSession:true,send:true,dispatch:true,interrupt:true,cancelQueued:true,stop:true,getTasks:true,listAgents:true,listSessions:true };
const ctx = (o={}) => ({ capabilities: full, operator: { kind:'user', allowlisted:true }, ...o });
console.log('registry', C.larkCommandRegistry.map(d=>[d.name, d.aliases, d.mutating]));
console.log('/stop alias resolve:', JSON.stringify(C.routeLarkCommand('/stop', ctx())?.command));
console.log('denied:', JSON.stringify(C.authorizeLarkCommandText('/cancel', ctx({operator:{kind:'user',allowlisted:false}}))));
console.log('unavailable:', JSON.stringify(C.authorizeLarkCommandText('/retry', ctx({capabilities:C.larkCommandCapabilities({})}))));
console.log('help route kind:', C.routeLarkCommand('/help', ctx()).kind);
const help = C.renderLarkCommandHelp(full);
console.log('help text head:', JSON.stringify(help.text.slice(0,120)), 'pages', help.totalPages);
const helpNoCaps = C.renderLarkCommandHelp(C.larkCommandCapabilities({}));
console.log('help with no caps lists:', JSON.stringify(helpNoCaps.text.slice(0,200)));
console.log('unknown:', JSON.stringify(C.routeLarkCommand('/nope x', ctx()).kind), JSON.stringify(C.authorizeLarkCommandText('/nope', ctx())));
console.log('not a command:', JSON.stringify(C.routeLarkCommand('hello', ctx()).kind));
// card actions
const walk=(n,f=[])=>{ if(Array.isArray(n)) n.forEach(x=>walk(x,f)); else if(n&&typeof n==='object'){ if(n.tag==='button') f.push(String(n.element_id??'?')); Object.values(n).forEach(v=>walk(v,f)); } return f; };
const caps={canCancelQueued:true,canInterrupt:true,canRetry:true,canRefresh:true};
for (const st of ['queued','running','completed','failed','interrupted']) {
  const live = S.buildLarkCard({ state: st, taskId:'t1', capabilities: caps });
  const frozen = S.buildLarkCard({ state: st, taskId:'t1', readOnly:true, sessionId:'ses_1', webBaseUrl:'https://w.example', capabilities:{...caps, webUrl:'https://w.example/sessions/ses_1'} });
  console.log(`state=${st} live=${JSON.stringify(walk(live))} frozen=${JSON.stringify(walk(frozen))}`);
}
// button behaviors → parseLarkCardActionValue accepted?
const live = S.buildLarkCard({ state:'running', taskId:'tsk', turn:2, capabilities: caps });
const collect=(n,f=[])=>{ if(Array.isArray(n)) n.forEach(x=>collect(x,f)); else if(n&&typeof n==='object'){ if(n.tag==='button') f.push(n); Object.values(n).forEach(v=>collect(v,f)); } return f; };
for (const b of collect(live)) {
  const val = b.behaviors?.[0]?.value;
  const parsed = A.parseLarkCardActionValue(val);
  console.log('btn', b.element_id, 'value', JSON.stringify(val), 'parsed', JSON.stringify(parsed));
}
