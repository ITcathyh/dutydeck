import { isLarkGroupMemoryPool, isLarkPerGroupMemoryPool, isLarkMemoryId, isLarkMemoryIgnoreRuleId, larkMemoryScope, renderLarkMemoryList } from '../memory.js';
import { isBotSenderType } from '../card-mentions.js';
import { larkMemoryEnabled } from '../config.js';
import { larkCommandEcho } from '../commands.js';
import type { ChatCommandHandler } from './command-context.js';

export const handleRemember: ChatCommandHandler = async (ctx) => {
  const { event, config, replyCard, route } = ctx;
  if (!larkMemoryEnabled(config)) {
    await replyCard(`/${route.command} 未执行`, '本机器人已关闭会话记忆。', { failed: true });
    return 'handled';
  }
  const memory = ctx.memory!;
  const scope = larkMemoryScope(config.appId, event.chatId, event.chatType, config.groupMemoryScope);
  const shared = isLarkGroupMemoryPool(scope);
  const perGroup = isLarkPerGroupMemoryPool(scope);
  const chatLabel = perGroup ? '本群' : '本聊天';
  if (route.command === 'memory') {
    if (route.args[0] === 'consolidate') {
      // /memory 整体是只读命令，但 consolidate 会改写账本：这里单独挡住机器人发送者，
      // 与 /remember、/forget 的 mutating 口径一致。
      if (isBotSenderType(event.senderType)) {
        await replyCard('/memory consolidate 未执行', '机器人发送者不能整理本聊天的记忆。', { failed: true });
        return 'handled';
      }
      const pipeline = ctx.memoryOptions?.pipeline;
      if (!pipeline) {
        await replyCard('/memory consolidate 未执行', '整理功能未启用。', { failed: true });
        return 'handled';
      }
      const outcome = await pipeline.requestConsolidation(scope, { ...(event.senderOpenId ? { actorId: event.senderOpenId } : {}) });
      if (outcome === 'started') await replyCard('会话记忆整理', '**已开始整理，完成后 `/memory` 可见。**');
      else if (outcome === 'running') await replyCard('/memory consolidate 未执行', '**整理正在进行中。**', { failed: true });
      else await replyCard('/memory consolidate 未执行', '本机器人已关闭会话记忆。', { failed: true });
      return 'handled';
    }
    if (route.args[0] === 'ignore') {
      // 「不许记」规则跟记忆池走：群聊里对本机器人所在各群都生效。增删改写的是约束，与 consolidate 一样挡住机器人发送者。
      // 共享池里规则原文常带敏感话题，各群只能查看和删除本群设置的规则。
      const [, action, id, ...extra] = route.args;
      const ownRules = shared ? { chatId: event.chatId } : {};
      if (!action || (action === 'list' && !id)) {
        const rules = await memory.listIgnoreRules(scope, ownRules);
        await replyCard('不许记规则', rules.length
          ? `**${shared ? `本群设置的「不许记」规则（${rules.length} 条，对本机器人所在各群都生效）` : `${chatLabel}的「不许记」规则（${rules.length} 条）`}**\n\n${rules.map(rule => `- \`${rule.id}\` · ${larkCommandEcho(rule.text, 200)}`).join('\n')}\n\n新增：\`/memory ignore <一句话描述>\`；删除：\`/memory ignore remove <编号>\``
          : `**${shared ? '本群' : ''}还没有「不许记」规则。**\n\n发送 \`/memory ignore <一句话描述>\` 添加，例如 \`/memory ignore 不要记任何人的薪资\`。后台提取会把规则当作约束，写入前再按规则过滤一次。`);
        return 'handled';
      }
      if (isBotSenderType(event.senderType)) {
        await replyCard('/memory ignore 未执行', '机器人发送者不能修改「不许记」规则。', { failed: true });
        return 'handled';
      }
      if (action === 'remove') {
        if (!isLarkMemoryIgnoreRuleId(id) || extra.length) {
          await replyCard('/memory ignore 未执行', '**用法：`/memory ignore remove <规则编号>`**\n\n编号形如 `ign_1a2b3c4d`，发送 `/memory ignore list` 查看。', { failed: true });
          return 'handled';
        }
        const removed = await memory.removeIgnoreRule(scope, id, ownRules);
        if (!removed) {
          await replyCard('/memory ignore 未执行', `**${shared ? '本群设置的规则里' : chatLabel}没有编号为 \`${id}\` 的「不许记」规则。**\n\n发送 \`/memory ignore list\` 查看。`, { failed: true });
          return 'handled';
        }
        await replyCard('已删除不许记规则', `**已删除规则 \`${removed.id}\`。**\n\n${larkCommandEcho(removed.text, 200)}\n\n之后的后台提取不再受这条规则约束。`);
        return 'handled';
      }
      const rule = await memory.addIgnoreRule(scope, { text: route.argsText.replace(/^ignore\s*/i, ''), chatId: event.chatId,
        ...(event.senderOpenId ? { createdBy: event.senderOpenId } : {}) });
      await replyCard('已添加不许记规则', `**已添加规则 \`${rule.id}\`${shared ? '（对本机器人所在各群都生效）' : ''}。**\n\n${larkCommandEcho(rule.text, 200)}\n\n之后的后台提取不会记下与它相关的内容；已有的记忆不受影响，可用 \`/forget <编号>\` 删除。查看：\`/memory ignore list\`；删除：\`/memory ignore remove ${rule.id}\`。`);
      return 'handled';
    }
    let page: number | undefined;
    if (route.args.length > 0) {
      page = Number(route.args[0]);
      if (!Number.isInteger(page) || page < 1) {
        await replyCard('/memory 未执行', '**用法：`/memory [页码]`、`/memory consolidate` 或 `/memory ignore <描述>`**', { failed: true });
        return 'handled';
      }
    }
    const pipeline = ctx.memoryOptions?.pipeline;
    const [byTopic, state, status] = await Promise.all([
      memory.byTopic(scope),
      memory.getState(scope),
      pipeline ? pipeline.status(scope) : memory.status(scope)
    ]);
    const result = renderLarkMemoryList(byTopic, state, { page, shared, perGroup, currentChatId: event.chatId, status });
    if (page !== undefined && page > result.totalPages) {
      await replyCard('/memory 未执行', `**页码超出范围，共 ${result.totalPages} 页。**\n\n发送 \`/memory 1\` 查看第一页。`, { failed: true });
      return 'handled';
    }
    await replyCard('会话记忆', result.text);
    return 'handled';
  }
  if (route.command === 'remember') {
    if (!route.argsText) {
      await replyCard('/remember 未执行', '**用法：`/remember <要记住的内容>`**\n\n例如：`/remember 这个群的回复统一用中文`。', { failed: true });
      return 'handled';
    }
    const entry = await memory.add(scope, { content: route.argsText, source: 'user', topic: 'general', chatId: event.chatId,
      ...(event.senderOpenId ? { createdBy: event.senderOpenId } : {}), messageId: event.messageId });
    await replyCard('已记住', shared
      ? `**已保存为群共享记忆 \`${entry.id}\`。**\n\n${larkCommandEcho(entry.content, 200)}\n\n之后本机器人所在各群的每轮任务都会带给 Agent（在其他群里作为背景）。查看：\`/memory\`；删除：\`/forget ${entry.id}\`。`
      : `**已保存为${perGroup ? '本群独立记忆（其他群看不到）' : '本聊天记忆'} \`${entry.id}\`。**\n\n${larkCommandEcho(entry.content, 200)}\n\n之后${chatLabel}的每轮任务都会带给 Agent。查看：\`/memory\`；删除：\`/forget ${entry.id}\`。`);
    return 'handled';
  }
  const [id, ...extra] = route.args;
  if (!isLarkMemoryId(id) || extra.length) {
    await replyCard('/forget 未执行', '**用法：`/forget <记忆编号>`**\n\n编号形如 `mem_1a2b3c4d`，发送 `/memory` 查看。', { failed: true });
    return 'handled';
  }
  const removed = await memory.remove(scope, id, event.senderOpenId);
  if (!removed) {
    await replyCard('/forget 未执行', `**${shared ? '群共享记忆' : chatLabel}没有编号为 \`${id}\` 的记忆。**\n\n发送 \`/memory\` 查看当前记忆。`, { failed: true });
    return 'handled';
  }
  await replyCard('已忘记', `**已删除记忆 \`${removed.id}\`。**\n\n${larkCommandEcho(removed.content, 200)}\n\n之后的任务不再带上这条记忆。`);
  return 'handled';
};
