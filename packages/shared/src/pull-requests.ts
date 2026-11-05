/** 会话改动开成 PR/MR 与之后跟进（`/pr`、Web「开 PR」）对外展示的形状。平台差异都在 CiProvider 里。 */

export type PullRequestStatus =
  /** 已生成确认清单，等有权限的人确认；确认前不推送任何东西。 */
  | 'proposed'
  /** 已确认，正在推送分支、开 PR。 */
  | 'pushing'
  /** PR 已开出，正在跟进 CI 和评审意见。 */
  | 'open'
  | 'merged' | 'closed'
  /** 自动跟进已停下（达到轮次上限、改动超限、推送被拒等），PR 本身仍在。 */
  | 'stopped'
  | 'cancelled' | 'expired'
  /** 推送或开 PR 失败。 */
  | 'failed'
  /** 自动修复这一轮改完了，推送前正在工作区跑机器人的验证命令；只出现在对外展示里。 */
  | 'verifying'
  /** 推送前验证没有通过：没推送、没提交，改动留在工作区，等人选「仍然推送」或「停止跟进」；只出现在对外展示里。 */
  | 'needs_attention';

export interface PullRequestFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

export interface PullRequestExcludedFile {
  path: string;
  /** not_session：不是本会话改的；changed_after：本会话改过，之后又被别的改动改过，无法确认。 */
  reason: 'not_session' | 'changed_after';
}

export interface PublicPullRequest {
  id: string;
  sessionId: string;
  provider: string;
  providerName: string;
  repository: string;
  status: PullRequestStatus;
  title: string;
  /** PR 正文的前几行，确认卡与确认框展示用。 */
  bodySummary: string;
  branch: string;
  target: string;
  baseSha: string;
  files: PullRequestFile[];
  excluded: PullRequestExcludedFile[];
  /** 本地还没推到目标分支的提交，会一起出现在 PR 里。 */
  commits: Array<{ sha: string; subject: string }>;
  /** 无法确认本地提交是否已在目标分支上（没有远端跟踪分支）。 */
  commitsUnverified?: boolean;
  headSha?: string;
  pullRequest?: { number: number; url: string; label: string };
  ciRounds: number;
  reviewRounds: number;
  /** 认领的已有 PR（`/pr follow`）：不是 DutyDeck 开的，跟进时推到它原来的源分支。 */
  claimed?: boolean;
  reason?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestAvailability {
  available: boolean;
  /** 不可用时说明装哪个插件。 */
  hint?: string;
}
