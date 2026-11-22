interface BackgroundKind {
  usageOrigin: string;
  userSettingsOnly: boolean;
  hookMode: 'normal' | 'deny-only';
  hidden: boolean;
  injectHost: boolean;
  botScoped: boolean;
  managesQueueExpiry?: boolean;
}

// Persisted source values are also used when creating or resuming a particular kind.
export const backgroundSource = {
  memory: 'lark-memory',
  decision: 'lark-decision',
  response: 'lark-response',
  replyPolish: 'lark-reply-polish',
  leader: 'lark-leader'
} as const;

export const backgroundKinds = {
  [backgroundSource.memory]: { usageOrigin: 'memory', managesQueueExpiry: true, userSettingsOnly: true, hookMode: 'deny-only', hidden: true, injectHost: true, botScoped: true },
  [backgroundSource.decision]: { usageOrigin: 'decision', userSettingsOnly: true, hookMode: 'deny-only', hidden: false, injectHost: true, botScoped: true },
  [backgroundSource.response]: { usageOrigin: 'response', userSettingsOnly: true, hookMode: 'deny-only', hidden: false, injectHost: true, botScoped: true },
  [backgroundSource.replyPolish]: { usageOrigin: 'reply_polish', userSettingsOnly: false, hookMode: 'deny-only', hidden: true, injectHost: false, botScoped: true },
  [backgroundSource.leader]: { usageOrigin: 'leader', userSettingsOnly: false, hookMode: 'normal', hidden: false, injectHost: true, botScoped: false }
} as const satisfies Record<string, BackgroundKind>;

export function backgroundKindFor(source: string | null | undefined): BackgroundKind | undefined {
  return source && Object.hasOwn(backgroundKinds, source) ? backgroundKinds[source as keyof typeof backgroundKinds] : undefined;
}
