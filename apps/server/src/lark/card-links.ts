import { z } from 'zod';
import type { LarkCardLink } from '@dutydeck/shared';

const linkUrl = z.string().trim().min(1).max(2048).refine(value => {
  try { const url = new URL(value); return !['javascript:', 'vbscript:', 'data:'].includes(url.protocol); } catch { return false; }
}, 'Use an absolute URL without an executable scheme');
const schema = z.array(z.object({
  label: z.string().trim().min(1).max(12),
  url: linkUrl.refine(value => new URL(value).protocol === 'https:', 'url must use https'),
  android_url: linkUrl.optional(), ios_url: linkUrl.optional(), pc_url: linkUrl.optional()
}).strict()).max(2);
export function parseCardLinks(value: unknown): LarkCardLink[] {
  return schema.parse(value === '' || value === null || value === undefined ? [] : value);
}
/** Old optional links must not prevent the bot or its task cards from loading. */
export function readCardLinks(value: unknown): LarkCardLink[] {
  const parsed = schema.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}
export function cardLinkElements(links: LarkCardLink[] | undefined, sessionId: string | undefined) {
  if (!links?.length || !sessionId) return [];
  return readCardLinks(links).flatMap(link => {
    const multi_url = Object.fromEntries(['url', 'android_url', 'ios_url', 'pc_url'].flatMap(key => {
      const value = link[key as keyof LarkCardLink];
      return value ? [[key, value.replaceAll('{sessionId}', encodeURIComponent(sessionId))]] : [];
    }));
    if (Object.values(multi_url).some(value => value.length > 2048)) return [];
    return [{ tag: 'button', type: 'default', text: { tag: 'plain_text', content: link.label }, multi_url }];
  });
}
