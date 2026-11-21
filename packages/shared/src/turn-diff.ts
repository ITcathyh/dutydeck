import { z } from 'zod';

export type TurnDiffSummary = { files: number; additions: number; deletions: number };
export type TurnDiffLine = { kind: 'context' | 'add' | 'del'; oldLine?: number; newLine?: number; text: string };
export type TurnDiffHunk = { header: string; lines: TurnDiffLine[] };
export type TurnDiffFile = {
  path: string; oldPath?: string; status: 'added' | 'deleted' | 'modified' | 'renamed';
  additions: number; deletions: number;
  /**
   * binary：二进制文件；too_large：单个文件超过上限；omitted：整页超过上限后没有展开的文件；
   * folded_lockfile / folded_generated：锁文件、.gitattributes 标了 linguist-generated 的文件默认折叠，只给统计，
   * 不读正文、不占整页预算；要看时按文件单独读（readTurnDiffFile）。
   */
  placeholder?: 'binary' | 'too_large' | 'omitted' | 'folded_lockfile' | 'folded_generated';
  hunks: TurnDiffHunk[];
};
export type TurnDiffView = { sessionId: string; taskId: string; summary: TurnDiffSummary; files: TurnDiffFile[]; truncated: boolean; finishedAt?: string };
export type TurnDiffResponse = TurnDiffView & { title?: string; access: 'shared' | 'owner' };

export const turnDiffCommentsRequestSchema = z.object({
  comments: z.array(z.object({
    path: z.string().min(1).max(1024),
    side: z.enum(['old', 'new']),
    line: z.number().int().min(1).max(10_000_000),
    body: z.string().trim().min(1).max(2000)
  }).strict()).min(1).max(20)
}).strict();
export type TurnDiffCommentInput = z.infer<typeof turnDiffCommentsRequestSchema>['comments'][number];
