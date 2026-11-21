import { backgroundKindFor, type PromptPart, type Session } from '@dutydeck/shared';
import { isFrozenCollaborationSession } from '../prompt-context.js';

const stages = { channel: 0, capability: 1, host: 2 };

export interface PromptContributor {
  stage: keyof typeof stages;
  order: number;
  sessions: 'all' | 'host-enabled';
  contribute: (previous: readonly PromptPart[]) => PromptPart[] | Promise<PromptPart[]>;
}

export async function composePromptParts(session: Session, contributors: readonly PromptContributor[]): Promise<PromptPart[]> {
  const hostEnabled = backgroundKindFor(session.source)?.injectHost !== false && !isFrozenCollaborationSession(session);
  const ordered = contributors.filter(entry => entry.sessions === 'all' || hostEnabled)
    .sort((a, b) => stages[a.stage] - stages[b.stage] || a.order - b.order);
  const parts: PromptPart[] = [];
  for (const entry of ordered) parts.push(...await entry.contribute(parts));
  return parts;
}
