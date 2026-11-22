import { readGitCodeSignature, readGitStatusLine } from '../git-status.js';
import type { TurnContext, TurnContributor } from './types.js';

export function gitStatusContributor({ session }: TurnContext) {
  let codeSignatureBefore: string | undefined;
  return {
    async captureWorkspace() { codeSignatureBefore = await readGitCodeSignature(session.cwd); },
    async inspectResult(state, result) {
      result.changedCode = state === 'completed' && codeSignatureBefore !== undefined
        && await readGitCodeSignature(session.cwd) !== codeSignatureBefore;
    },
    async decorateResult(state, result, workspace) {
      const cwd = session.cwd ?? workspace;
      const status = result.changedCode && state === 'completed' && cwd ? await readGitStatusLine(cwd) : undefined;
      if (status) result.gitStatus = { tag: 'markdown', element_id: 'git_status', content: status };
    },
  } satisfies TurnContributor;
}
