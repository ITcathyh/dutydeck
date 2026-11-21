import { installationOwnerTaskActor, type StoredLarkConfig } from '@dutydeck/shared';

export const defaultHighRiskPattern = String.raw`(?:^|[\s;&|])(?:sudo|rm|shred|dd|mkfs|diskutil|launchctl|kill|pkill|lark-?cli|larkcli|bits-?cli|bitscli|bytedcli|ssh|scp|rsync|osascript)\b|\bgit\s+(?:push|reset|clean|checkout)\b|\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish)\b|\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b`;

export async function allowedHighRiskActor(
  config: Pick<StoredLarkConfig, 'highRiskAllowedUsers' | 'highRiskAllowedEmails'>,
  actorId: string | undefined,
  lookupEmails: (openId: string) => Promise<string[]>,
  log: { warn(details: unknown, message: string): void } = console,
  onLookupError: 'deny' | 'throw' = 'deny'
): Promise<boolean> {
  const { highRiskAllowedUsers, highRiskAllowedEmails } = config;
  if (actorId === installationOwnerTaskActor || (!highRiskAllowedUsers.length && !highRiskAllowedEmails.length)) return true;
  if (!actorId) return false;
  if (highRiskAllowedUsers.some(user => user.openId === actorId)) return true;
  if (!highRiskAllowedEmails.length) return false;
  try {
    return (await lookupEmails(actorId)).some(email => highRiskAllowedEmails.includes(email));
  } catch (error) {
    log.warn({ error }, 'High-risk actor email lookup failed');
    if (onLookupError === 'throw') throw error;
    return false;
  }
}
