import type { PermissionMode, Session } from './api';

type NewSessionDraft = {
  agentId: string;
  cwd: string;
  workspaceMode: 'shared' | 'worktree';
  model: string;
  reasoningEffort: string;
  permissionMode: PermissionMode;
  goal: string;
  createdSession?: Session;
};

// Like management drafts, survives view unmounts for this page lifetime only.
// Keep task and schedule setup separate, and never reuse a draft across instances.
export const newSessionDrafts = new Map<string, NewSessionDraft>();
