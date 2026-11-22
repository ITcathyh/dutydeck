import { larkCommandEcho } from '../commands.js';
import { buildRepairConfirmCard } from '../repair.js';
import type { ChatCommandHandler } from './command-context.js';

const describeLarkAccess = (mode: 'owner_only' | 'allowlist' | 'all_chat_members' | 'disabled') =>
  ({ owner_only: '仅机器人管理员可用', allowlist: '仅名单内成员可用', all_chat_members: '全部群成员可用', disabled: '本群已停用' })[mode];

export const handleRepair: ChatCommandHandler = async (ctx) => {
  const { event, config, replyCard } = ctx;
  // 安装级发布动作：发卡前就按 high_risk/静态白名单口径拦一道，无权成员看不到确认卡。
  const repairAuth = await ctx.isRepairOperatorAllowed(config, event.senderOpenId, event.chatId);
  if (!repairAuth.allowed) {
    const reason = repairAuth.reason === 'unconfigured'
      ? '未配置操作白名单时，飞书里不能执行 /repair，请在 Web 上操作。'
      : '当前账号无权执行应用修复：需要安装管理员权限。';
    await replyCard('/repair 未执行', reason, { failed: true });
    return 'handled';
  }
  // 只发二次确认卡；真正的发布动作只能由确认卡回调触发（handleAction 的 dutydeck_repair 分支）。
  const card = buildRepairConfirmCard(config.appId);
  await replyCard(card.title, card.markdown, { elements: card.elements });
  return 'handled';
};

export const handleGrant: ChatCommandHandler = async (ctx) => {
  const { event, config, replyCard, route } = ctx;
  const command = route.command === 'grant' ? 'grant' : 'revoke';
  const { argsText } = route;
  const manager = ctx.groupManager;
  if (!manager || event.chatType !== 'group') throw new Error('只有群聊里才有可修改的对话授权。');
  const state = await manager.groupAccess(config.appId, event.chatId);
  if (!state) throw new Error('本群还没有在 Dutydeck 中同步群配置，聊天里没有可修改的授权。请管理员先在 Dutydeck Web 同步此机器人的群聊。');
  if (!await ctx.isGrantOperatorAllowed(config, event.senderOpenId, event.chatId, command === 'grant' ? 'grant.create' : 'grant.revoke')) {
    await replyCard(`/${command} 未执行`, '当前账号没有修改本群授权的权限：需要本机器人的管理员，或已被授予高风险操作权限的群成员。', { failed: true });
    return 'handled';
  }
  // 目标成员只认真实的飞书提及（带 open_id），机器人自己的提及不算目标。
  const mentioned = event.mentions.filter(mention => mention.openId && mention.openId !== ctx.botOpenId);
  if (!mentioned.length && argsText) {
    throw new Error('请用 @ 选中要操作的群成员，例如 `/grant @张三`。纯文字的名字解析不出群成员身份。');
  }
  const targets: string[] = [];
  const unresolved: string[] = [];
  for (const mention of mentioned) {
    const principal = await manager.resolveGroupPrincipal(config.appId, event.chatId, mention.openId!);
    if (principal) targets.push(principal);
    else unresolved.push(mention.name || mention.openId!);
  }
  if (unresolved.length) {
    throw new Error(`这些成员解析不到本群身份，本次授权没有做任何修改：${unresolved.map(name => larkCommandEcho(name, 40)).join('、')}。请确认他们仍在本群中。`);
  }
  // 基准只取**本群自己**的名单。继承来的机器人默认名单不是本群的 principal，
  // 把它抄进群覆盖会写进一批没登记过身份的 principal，被 save 的作用域校验直接打回。
  const own = state.override.mode === 'allowlist' ? state.override.principalIds : undefined;
  if (command === 'revoke' && targets.length && !own) {
    throw new Error(`本群现在不是按名单授权（当前：${describeLarkAccess(state.effective.mode)}），没有可移除的名单。要整体收回请直接发送 \`/revoke\`；要改成名单请先用 \`/grant @成员\` 建立。`);
  }
  const next = targets.length
    ? (() => {
      const list = new Set(own ?? []);
      for (const id of targets) command === 'grant' ? list.add(id) : list.delete(id);
      return list.size
        ? { mode: 'allowlist' as const, principalIds: [...list] }
        : { mode: 'owner_only' as const, principalIds: [] };
    })()
    : command === 'grant'
      ? { mode: 'all_chat_members' as const, principalIds: [] }
      : { mode: 'owner_only' as const, principalIds: [] };
  await manager.save(config.appId, event.chatId, { expectedRevision: state.revision, patch: { accessOverride: next } });
  const summary = next.mode === 'all_chat_members' ? '本群所有成员都可以使用本机器人'
    : next.mode === 'allowlist' ? `仅名单内 ${next.principalIds.length} 人可以使用本机器人`
      : '仅本机器人的管理员可以使用';
  // 建了本群自己的名单就必须写出改之前是什么。从「继承机器人默认」切到群名单时，
  // 原先按机器人默认（allowedUsers / allowedEmails）放行的人会一起失效——
  // 这一步恰恰是用户最容易没想到的，必须显式说出来，不能只报改完的结果。
  const narrowed = next.mode !== 'allowlist' || state.override.mode === 'allowlist' ? ''
    : state.override.mode === 'inherit'
      ? `\n\n此前本群继承机器人默认授权（${describeLarkAccess(state.effective.mode)}），现在改为本群自己的名单：原先按机器人默认放行的成员不再自动可用。`
      : `\n\n此前本群是「${describeLarkAccess(state.effective.mode)}」，现在改为本群自己的名单。`;
  const oncall = state.oncall ? '\n\n本群仍处于值班模式：值班期间所有群成员都能使用，名单要等关闭值班后才生效。' : '';
  // 「谁能用」不止这一条口径：Web 上单独授予过 can_talk / can_operate 角色的成员
  // 不受群 access 影响，回执不能把结论说成排他的。
  await replyCard(`/${command} 已生效`, `**本群授权已改为：${summary}。**${narrowed}${oncall}\n\n在 Dutydeck Web 上单独授予过角色的成员不受本命令影响，需要到 Web 上撤销。`);
  return 'handled';
};
