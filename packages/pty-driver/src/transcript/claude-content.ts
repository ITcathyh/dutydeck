/** Does an entry's text content mention the marker? Handles both the string
 *  and the content-block array form of `message.content`. */
export function entryMentionsMarker(entry: any, marker: string): boolean {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.includes(marker);
  if (!Array.isArray(content)) return false;
  return content.some((block: any) =>
    block && typeof block === 'object' && typeof block.text === 'string' && block.text.includes(marker));
}
