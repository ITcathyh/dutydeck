import { mergeGroupTaskWatermark } from '../group-task-context.js';
import { withLarkContextReadTimeout } from '../context-read-timeout.js';
import { larkMessageAnchor } from '../message-anchor.js';
import { larkMaterialMessageIds } from '../task-context.js';
import type { TurnContributor, TurnContext, TurnPrompt } from './types.js';

export function groupContextContributor({ task, session, config, event, options, log, materialParts }: TurnContext, prompt: TurnPrompt) {
  // 群上下文按运行时会话增量注入，水位只在确认 prompt 已提交给 Agent 后推进。运行时对外只暴露任务状态：
  // running 在领取时就发，此时可能还在准备、尚未提交；completed / interrupted 只能来自已提交轮次的驱动结果
  // 或人工确认，failed 分不清是否提交过。所以只认这两种终态；其余终态、准备失败或重放旧任务都保留旧水位，
  // 下一轮按旧水位重读，内容只会更多不会漏。
  let groupContextCommit: (() => Promise<unknown>) | undefined;
  return {
    async readContext() {
      if (event.chatType !== 'group' || !options.participation) return;
      const store = options.store;
      const watermarkKey = `lark.group-context.${config.appId}.${session.id}`;
      const watermark = await store.get(watermarkKey);
      const materialMessageIds = larkMaterialMessageIds(materialParts, event.chatId);
      const observedContext = await withLarkContextReadTimeout(options.participation.taskContext({ appId: config.appId, chatId: event.chatId }, { triggerMessageId: larkMessageAnchor(event), watermark, groupTools: config.groupToolsEnabled, materialMessageIds }), '群上下文读取');
      if (observedContext) {
        prompt.groupContext = observedContext;
        // 排队的几轮都基于同一个旧水位；后完成的一轮 CAS 失败时读出当前值合并再写，最多 3 次，仍冲突就留日志。
        if (store.compareAndSet) groupContextCommit = async () => {
          let expected = watermark;
          let next = observedContext.watermark;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (await store.compareAndSet!(watermarkKey, expected, next)) return;
            expected = await store.get(watermarkKey);
            next = mergeGroupTaskWatermark(expected, observedContext.watermark);
            if (next === expected) return;
          }
          throw new Error('群上下文水位写回多次冲突');
        };
      }
      if (options.participation.instructionsSnapshot) {
        const snapshot = await withLarkContextReadTimeout(options.participation.instructionsSnapshot({ appId: config.appId, chatId: event.chatId }), '群长期指令读取');
        prompt.groupInstructions = snapshot.instructions.trim();
        if (prompt.groupInstructions) prompt.groupInstructionsRevision = snapshot.revision;
      } else prompt.groupInstructions = (await withLarkContextReadTimeout(options.participation.instructions({ appId: config.appId, chatId: event.chatId }), '群长期指令读取')).trim();
    },
    onReplay() { groupContextCommit = undefined; },
    async settling(status) {
      const commit = groupContextCommit;
      groupContextCommit = undefined;
      if (status !== 'completed' && status !== 'interrupted') return;
      await commit?.().catch(error => log.warn({ error, taskId: task.id, sessionId: session.id }, '群上下文水位推进失败，下一轮按旧水位注入'));
    },
  } satisfies TurnContributor;
}
