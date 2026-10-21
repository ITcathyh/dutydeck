import type { RepositoryBundle, PluginResultDelivery } from '@dutydeck/shared';
import { isAutomatedRequest } from '../agent-request-tools.js';
import type { LarkAgentToolCapabilityRegistry, LarkAgentSessionBinding } from './agent-tools.js';
import { larkAgentSessionBinding } from './agent-tools.js';
import { resolveExplicitFinalContext } from './explicit-final.js';
import { readLarkConfig, type StoredLarkConfig } from './config.js';
import type { LarkGroupManager } from './group-management.js';
import type { LarkCardService } from './service.js';
import { readConfirmedLarkResult, sendLarkResult } from './result-delivery.js';
import { PluginResultError, type PluginResultAdapter, type PluginResultAuthority } from '../plugins/result-service.js';
import type { PluginResultIdentity } from './plugin-result-identity.js';
interface Runtime { getActiveTaskContext(id: string): {taskId:string;attemptId?:string;actorId?:string}|undefined }
export interface LarkPluginResultOptions {
  repositories: RepositoryBundle; capabilities: LarkAgentToolCapabilityRegistry; runtime: Runtime;
  groupManager: Pick<LarkGroupManager,'authorize'|'resolved'>;
  client(bot: StoredLarkConfig): LarkCardService;
  identity: PluginResultIdentity;
  authorizePolicy(): Promise<{allowed:boolean}>;
}
export class LarkPluginResultAdapter implements PluginResultAdapter {
  constructor(private readonly options: LarkPluginResultOptions) {}
  private async authorize(binding: LarkAgentSessionBinding, actorId: string) {
    const bot=await readLarkConfig(this.options.repositories.config,binding.appId);
    if (!bot || !bot.listening || !bot.groupToolsEnabled || !bot.groupToolsAllowSend || !(await this.options.authorizePolicy()).allowed) throw new PluginResultError('RESULT_PERMISSION_DENIED');
    const decision=await this.options.groupManager.authorize(binding.appId,binding.chatId,actorId,'group_tools.send',binding.sessionId,{taskRequesterOpenId:actorId});
    if (decision && !decision.allowed) throw new PluginResultError('RESULT_PERMISSION_DENIED');
    if (!decision) {
      if ((bot.allowedUsers.length || bot.allowedEmails.length) && !bot.allowedUsers.some(user=>user.openId===actorId)) {
        const emails=bot.allowedEmails.length ? await this.options.client(bot).getUserEmails(actorId) : [];
        if (!emails.some(email=>bot.allowedEmails.includes(email))) throw new PluginResultError('RESULT_PERMISSION_DENIED');
      }
      if (binding.chatType==='group') {
        let member=false, pageToken: string | undefined;
        for (let page=0;page<20;page++) {
          const result=await this.options.client(bot).listChatMembers({chatId:binding.chatId,pageSize:100,...(pageToken?{pageToken}:{})});
          if (result.items.some(item=>item.memberId===actorId)) { member=true; break; }
          if (!result.hasMore || !result.pageToken) break;
          pageToken=result.pageToken;
        }
        if (!member) throw new PluginResultError('RESULT_PERMISSION_DENIED');
      }
    }
    const resolved=await this.options.groupManager.resolved(bot,binding.chatId);
    if (!resolved.groupToolsEnabled || !resolved.groupToolsAllowSend) throw new PluginResultError('RESULT_PERMISSION_DENIED');
    const current=await readLarkConfig(this.options.repositories.config,binding.appId);
    // A policy/credential change during a platform await requires a fresh call; no stale snapshot is accepted.
    if (!current || JSON.stringify(current)!==JSON.stringify(bot)) throw new PluginResultError('RESULT_PERMISSION_DENIED');
    return bot;
  }
  private async check(binding: LarkAgentSessionBinding, ref: {taskId:string;attemptId:string;runId:string;actorId:string}, live: boolean) {
    const { repositories:repos }=this.options;
    const accepted=repos.execution.getAcceptedTask(ref.taskId);
    const request=accepted?.request, actor=request?.actor;
    if (!accepted || request?.sessionId!==binding.sessionId || !['lark','runtime'].includes(request.namespace) || actor?.kind!=='channel' || actor.appId!==binding.appId || actor.id!==ref.actorId || isAutomatedRequest(request)
      || accepted.task.sessionId!==binding.sessionId || accepted.task.currentAttemptId!==ref.attemptId || ['cancelled','interrupted','failed'].includes(accepted.task.status)) throw new PluginResultError('RESULT_REQUESTER_REQUIRED');
    if (accepted.task.status==='reconcile_required') throw new PluginResultError('RESULT_TASK_UNRESOLVED',503);
    const session=await repos.sessions.get(binding.sessionId);
    const attempt=repos.execution.getAttempt({sessionId:binding.sessionId,runId:ref.runId,taskId:ref.taskId,attemptId:ref.attemptId});
    if (!session || (live && (session.runId!==ref.runId || ['failed','stopped'].includes(session.state))) || session.archivedAt || !attempt || ['cancelled','interrupted','failed'].includes(attempt.outcome ?? '')) throw new PluginResultError('RESULT_TURN_EXPIRED');
    if (attempt.outcome==='unknown' || attempt.state==='reconcile_required') throw new PluginResultError('RESULT_TASK_UNRESOLVED',503);
    const currentBinding=larkAgentSessionBinding(session);
    if (!currentBinding || JSON.stringify(currentBinding)!==JSON.stringify(binding)) throw new PluginResultError('RESULT_TURN_EXPIRED');
    const assertActive=()=> {
      const active=this.options.runtime.getActiveTaskContext(binding.sessionId);
      if (!active || active.taskId!==ref.taskId || active.attemptId!==ref.attemptId || active.actorId!==ref.actorId) throw new PluginResultError('RESULT_TURN_EXPIRED');
    };
    if (live) assertActive();
    const bot=await this.authorize(binding,ref.actorId);
    const context=await resolveExplicitFinalContext(await repos.channelMappings.list(`lark-card:${binding.appId}`),binding,{taskId:ref.taskId,attemptId:ref.attemptId});
    if (!context) throw new PluginResultError('RESULT_ORIGIN_REQUIRED');
    const message=await this.options.client(bot).getMessage(context.scope.origin_message_id);
    if (message.deleted || message.sender.type!=='user' || message.sender.id!==ref.actorId || message.chatId!==binding.chatId || message.messageId!==context.scope.origin_message_id) throw new PluginResultError('RESULT_REQUESTER_REQUIRED');
    const redirect=await this.options.identity.redirectUri(binding.appId);
    await this.authorize(binding,ref.actorId);
    if (live) assertActive();
    // No await after the final durable task read: revocation at an earlier await cannot submit an old turn.
    const latest=repos.execution.getAcceptedTask(ref.taskId);
    if (latest?.task.status==='reconcile_required') throw new PluginResultError('RESULT_TASK_UNRESOLVED',503);
    if (latest?.task.currentAttemptId!==ref.attemptId || ['cancelled','interrupted','failed'].includes(latest?.task.status ?? 'failed')) throw new PluginResultError('RESULT_TURN_EXPIRED');
    return {session,bot,scope:context.scope,redirect};
  }
  async resolveRequester(token?:string,turn?:string): Promise<PluginResultAuthority> {
    try {
      if (!turn) throw new PluginResultError('RESULT_TURN_REQUIRED');
      const binding=await this.options.capabilities.resolve(token);
      const active=this.options.runtime.getActiveTaskContext(binding.sessionId);
      const session=await this.options.repositories.sessions.get(binding.sessionId);
      if (!active?.attemptId || !active.actorId || !session) throw new PluginResultError('RESULT_REQUESTER_REQUIRED');
      this.options.capabilities.assertFinalTurn(binding.sessionId,active.taskId,active.attemptId,turn);
      const ref={taskId:active.taskId,attemptId:active.attemptId,actorId:active.actorId,runId:session.runId};
      const checked=await this.check(binding,ref,true);
      const target={...checked.scope,web_base:checked.redirect.replace('/api/plugin-results/oauth/callback',''),cwd:checked.session.cwd,
        binding:JSON.stringify(binding)};
      const frozen=JSON.stringify(target);
      const assertCurrent=async()=> {
        try { const fresh=await this.check(binding,ref,true); if (JSON.stringify({...fresh.scope,web_base:fresh.redirect.replace('/api/plugin-results/oauth/callback',''),cwd:fresh.session.cwd,binding:JSON.stringify(binding)})!==frozen) throw new Error(); }
        catch (error) { if (error instanceof PluginResultError) throw error; throw new PluginResultError('RESULT_AUTHORIZATION_UNAVAILABLE',503); }
      };
      return {requester:{provider:'lark',tenant:binding.appId,subject:active.actorId},sessionId:binding.sessionId,runId:session.runId,taskId:active.taskId,attemptId:active.attemptId,target,cwd:session.cwd,assertCurrent};
    } catch (error) { if (error instanceof PluginResultError) throw error; throw new PluginResultError('RESULT_REQUESTER_REQUIRED'); }
  }
  async assertDeliveryAuthorized(delivery: PluginResultDelivery) {
    try {
      const binding=JSON.parse(String(delivery.target.binding)) as LarkAgentSessionBinding;
      if (delivery.requester.provider!=='lark' || binding.appId!==delivery.requester.tenant || binding.sessionId!==delivery.sessionId) throw new Error();
      const checked=await this.check(binding,{taskId:delivery.taskId,attemptId:delivery.attemptId,runId:delivery.runId,actorId:delivery.requester.subject},false);
      if (JSON.stringify({...checked.scope,web_base:checked.redirect.replace('/api/plugin-results/oauth/callback',''),cwd:checked.session.cwd,binding:JSON.stringify(binding)})!==JSON.stringify(delivery.target)) throw new Error();
    } catch (error) { if (error instanceof PluginResultError) throw error; throw new PluginResultError('RESULT_AUTHORIZATION_UNAVAILABLE',503); }
  }
  async deliverReceipt(delivery: PluginResultDelivery, guard: ()=>Promise<void>, recoverOnly:boolean) {
    const bot=await readLarkConfig(this.options.repositories.config,delivery.requester.tenant);
    if (!bot) throw new PluginResultError('RESULT_PERMISSION_DENIED');
    const client=this.options.client(bot), t=delivery.target;
    const target={chatId:String(t.chat_id),...(t.reply_message_id ? {replyMessageId:String(t.reply_message_id),replyInThread:t.reply_in_thread===true}:{}),allowReplyFallback:false};
    const input={state:'running' as const,readOnly:true,taskId:String(t.origin_message_id),sessionId:delivery.sessionId,turn:Number(t.turn),taskName:'受控插件结果',statusLabel:'结果已生成',
      elements:[{tag:'markdown',element_id:'final_output',content:`结果已生成，仅原请求者可查看。\n\n[查看和下载](${t.web_base}/plugin-results/${delivery.id})`}],idempotencyKey:delivery.providerKey};
    const silent={warn:(..._args:unknown[])=>{}};
    const sent=recoverOnly ? await readConfirmedLarkResult(client,target,input,silent,this.options.repositories.config)
      : await sendLarkResult(client,target,input,silent,this.options.repositories.config,guard);
    return sent?.messageId;
  }
}
