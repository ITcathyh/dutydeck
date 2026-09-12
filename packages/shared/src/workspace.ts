export const workspaceModes = ['shared', 'worktree'] as const;
export type WorkspaceMode = (typeof workspaceModes)[number];

export const workspacePreparationStates = ['preparing', 'ready', 'failed'] as const;
export type WorkspacePreparationState = (typeof workspacePreparationStates)[number];

/** Persisted ownership and recovery intent for a Session workspace. */
export interface SessionWorkspace {
  schemaVersion: 1;
  revision: number;
  sessionId: string;
  mode: WorkspaceMode;
  sourceCwd: string;
  cwd: string;
  state: WorkspacePreparationState;
  repoRoot?: string;
  gitCommonDir?: string;
  relativeCwd?: string;
  baselineCommit?: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

/** Browser-safe workspace response. Paths are already visible on Session today. */
export type WorkspaceResponse = Readonly<SessionWorkspace>;
