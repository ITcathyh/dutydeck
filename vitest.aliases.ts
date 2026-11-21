import { loadWorkspaceEntries } from './scripts/workspace-entries.mjs';

// Vite matches aliases in order and a package root can also match its subpaths.
export const vitestAliases = Object.fromEntries(
  Object.entries(loadWorkspaceEntries()).sort(([a], [b]) => b.length - a.length)
);
