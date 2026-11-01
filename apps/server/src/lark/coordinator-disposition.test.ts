import { it, expect, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { LarkMessageCoordinator } from './coordinator.js';
import { LarkTaskInbox } from './task-inbox.js';
it.each([
  ['not_addressed', 'user', false], ['bot_message', 'bot', false], ['bot_loop_guard', 'bot', true], ['access_denied', 'user', true], ['group_unbound', 'user', true], ['command_rejected', 'bot', true], ['backlog_expired', 'user', false]
] as const)('persists the %s routing branch', async (reason, senderType, mention) => {
 const repos = createRepositories(':memory:');
 const config = {appId:'cli_test',appSecret:'test',listening:true,mentionPolicy:'always',permissionMode:'ask',allowedUsers:[],allowedEmails:[],riskControlMode:'off'} as any;
 await repos.config.set('lark.bots',JSON.stringify([config]));
 const groupManager = reason === 'access_denied' || reason === 'group_unbound' ? {
   resolved: async () => { if (reason === 'group_unbound') throw Object.assign(new Error('未绑定'),{code:'LARK_GROUP_NOT_APPLIED'}); return config; },
   authorize: async () => ({allowed:false,code:'talk_required',reason:'没有权限'})
 } : undefined;
 const participation = reason === 'bot_loop_guard' ? {handle:async()=>({enabled:false}),guardBotTurn:async()=> '回路拦截'} : undefined;
 const coordinator = new LarkMessageCoordinator({} as any, {reply:vi.fn(async()=>({messageId:'reply'}))} as any,{info:vi.fn(),warn:vi.fn(),error:vi.fn()},Math.random,'ou_bot',undefined,undefined,async () => 'group',undefined,undefined,{store:repos.config,participation:participation as any,groupManager:groupManager as any} as any);
 if (groupManager) (coordinator as any).groupManager = groupManager;
 const event = {messageId:'om_1',chatId:'oc_1',chatType:'group',messageType:'text',content:reason === 'command_rejected' ? '{"text":"/new"}' : '{"text":"你好"}',senderOpenId:'ou_user',senderType,mentions:mention?[{openId:'ou_bot',key:'@_user_1',name:'测试机器人'}]:[]} as any;
 const inbox = new LarkTaskInbox(repos.config);
 if (reason === 'command_rejected') (coordinator as any).requireExecution = async () => {};
 if (reason === 'backlog_expired') await repos.config.set('lark.inbox.cli_test.om_1',JSON.stringify({appId:config.appId,event,state:'unrouted',boot:'previous',receivedAt:new Date(Date.now()-3600001).toISOString()}));
 try {
   await coordinator.receive(event,config);
   await vi.waitFor(async () => expect(await inbox.lookup(config.appId,event.messageId)).toMatchObject({reason}));
 } finally { coordinator.stop(); repos.close(); }
});
