import type { PromptPart } from '@dutydeck/shared';
import { collectLarkTaskContext } from '../../apps/server/src/lark/task-context.js';
import { assemblePrompt } from '../../apps/server/src/prompt-context.js';

/** Replay tool reads are isolated fixtures; both entry points read the same complete document snapshot. */
export async function prepareTokenPromptFixture() {
  const url = 'https://fixture.feishu.cn/docx/verified_document';
  const content = '验收依据：必须保留来源、完整正文和用户约束。\n'.repeat(40) + '反例：缺少完整审查不能判定完成。';
  const event = { messageId: 'om_fixture', chatId: 'oc_fixture', chatType: 'group' as const, messageType: 'text', content: JSON.stringify({ text: `核对 ${url}` }), mentions: [] };
  const service = {
    getMessage: async () => { throw new Error('No message lookup in this fixture'); },
    getMessageItems: async () => [], listChatMessages: async () => ({ items: [], hasMore: false }),
    readDocument: async (requested: string) => ({ url: requested, title: '冻结验收原文', text: content })
  };
  const current = await collectLarkTaskContext({ event, prompt: `核对 ${url}`, resources: [], service });
  const citation = await collectLarkTaskContext({ event: { ...event, messageId: 'om_citation' }, prompt: `引用的依据也来自 ${url}`, resources: [], service });
  const parts: PromptPart[] = [...current.promptParts, ...citation.promptParts.map((part, index) => ({ ...part, prefix: `${index === 0 ? '\n\n[独立引用入口]\n' : ''}${part.prefix ?? ''}` }))];
  const legacyPrompt = parts.map(part => `${part.prefix ?? ''}${part.content}${part.suffix ?? ''}`).join('');
  const optimized = assemblePrompt(parts, legacyPrompt, 'optimized-v1');
  return { legacyPrompt, optimizedPrompt: optimized.prompt, parts, diagnostics: optimized.diagnostics };
}
