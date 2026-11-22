// Expected behavior for sessions persisted before the background kind registry.
export const backgroundKindCases = [
  { source: 'lark-memory', usageOrigin: 'memory', managesQueueExpiry: true, userSettingsOnly: true, hookMode: 'deny-only', hidden: true, injectHost: true, botScoped: true },
  { source: 'lark-decision', usageOrigin: 'decision', userSettingsOnly: true, hookMode: 'deny-only', hidden: false, injectHost: true, botScoped: true },
  { source: 'lark-response', usageOrigin: 'response', userSettingsOnly: true, hookMode: 'deny-only', hidden: false, injectHost: true, botScoped: true },
  { source: 'lark-reply-polish', usageOrigin: 'reply_polish', userSettingsOnly: false, hookMode: 'deny-only', hidden: true, injectHost: false, botScoped: true },
  { source: 'lark-leader', usageOrigin: 'leader', userSettingsOnly: false, hookMode: 'normal', hidden: false, injectHost: true, botScoped: false }
] as const;
