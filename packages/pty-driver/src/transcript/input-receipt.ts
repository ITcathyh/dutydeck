/** Native user records only: tool results, scaffolding and assistant output
 * cannot acknowledge a terminal submission. The submitted body stays exact
 * apart from line endings; Claude's native paste envelope is removed at receipt. */
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
  const text = contentText(entry.message?.content);
  // Claude 2.1.287 persists bracketed paste in this exact envelope. Remove
  // only the paired outer tags; every character of the submitted body counts.
  return text?.replace(/^\n\n<pasted_content id="([\w-]+)">\n([\s\S]*)\n<\/pasted_content id="\1">\n$/, '$2');
}

export function codexInputText(entry: any): string | undefined {
  const payload = entry?.payload;
  if (entry?.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') return contentText(payload.content);
  if (entry?.type === 'event_msg' && payload?.type === 'user_message') return contentText(payload.message);
  if (entry?.type === 'event_msg' && payload?.type === 'item_completed' && payload.item?.type === 'UserMessage') return contentText(payload.item.content ?? payload.item.text);
  return undefined;
}
