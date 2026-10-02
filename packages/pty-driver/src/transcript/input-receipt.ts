/** Native user records only: tool results, scaffolding and assistant output
 * cannot acknowledge a terminal submission. Line endings are the only text
 * normalization; short messages and Unicode remain exact. */
export function normalizeInputText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const blocks = content.filter(block => block && (block.type === 'text' || block.type === 'input_text') && typeof block.text === 'string');
  return blocks.length ? blocks.map(block => block.text).join('') : undefined;
}

export function claudeInputText(entry: any): string | undefined {
  if (entry?.isSidechain === true || (entry?.message?.role ?? entry?.type) !== 'user') return undefined;
  return contentText(entry.message?.content);
}

export function codexInputText(entry: any): string | undefined {
  const payload = entry?.payload;
  if (entry?.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') return contentText(payload.content);
  if (entry?.type === 'event_msg' && payload?.type === 'user_message') return contentText(payload.message);
  if (entry?.type === 'event_msg' && payload?.type === 'item_completed' && payload.item?.type === 'UserMessage') return contentText(payload.item.content ?? payload.item.text);
  return undefined;
}
