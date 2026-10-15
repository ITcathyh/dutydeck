/** Native user records only: tool results, scaffolding and assistant output
 * cannot acknowledge a terminal submission. The submitted body stays exact
 * apart from line endings; Claude's native paste envelope is removed at receipt. */
export function normalizeInputText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function contentText(content: unknown, textTypes = ['text', 'input_text']): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const blocks = content.filter(block => block && textTypes.includes(block.type) && typeof block.text === 'string');
  return blocks.length ? blocks.map(block => block.text).join('') : undefined;
}

export function claudeInputText(entry: any): string | undefined {
  if (entry?.type === 'api-request-blob') return undefined;
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


export function traexDisplayCompletions(payload: any, threadId?: string): any[] {
  if (payload?.operation !== 'append' || typeof payload.turn_id !== 'string' || !payload.turn_id) return [];
  return (Array.isArray(payload.display_completions) ? payload.display_completions : []).filter((c: any) =>
    c?.turn_id === payload.turn_id && typeof c.thread_id === 'string' && c.thread_id && (!threadId || c.thread_id === threadId));
}

export function traexUserText(item: any): string | undefined {
  if (item?.type !== 'UserMessage' || (item.role !== undefined && item.role !== 'user')) return undefined;
  const text = contentText(item.content ?? item.text, ['text', 'Text', 'output_text', 'input_text']);
  return text === '' ? undefined : text;
}

/** Canonical model items are not user receipts; only thread/turn-validated
 * display UserMessages can acknowledge input or carry the session marker. */
export function traexInputText(entry: any, threadId?: string): string | undefined {
  if (entry?.type !== 'history_mutation') return codexInputText(entry);
  for (const completion of traexDisplayCompletions(entry.payload, threadId)) {
    const text = traexUserText(completion.item);
    if (text !== undefined) return text;
  }
  return undefined;
}
