import type { PublicPullRequest } from '@dutydeck/shared';
import { markdownElement } from './card-elements.js';
import type { LarkCardElement } from './card-renderer.js';

const fileLimit = 30;
const excludedReasons = { not_session: '不是本会话改的', changed_after: '本会话改过，之后又被改动，无法确认' } as const;

/** `/pr` 的确认卡：列出将推送的内容，确认按钮是推送的唯一入口。 */
export function buildPullRequestConfirmCard(proposal: PublicPullRequest): { title: string; markdown: string; elements: LarkCardElement[] } {
  const additions = proposal.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = proposal.files.reduce((sum, file) => sum + file.deletions, 0);
  const markdown = [
    `**确认后才会推送并开 PR**（${proposal.providerName}，${proposal.repository}）`,
    '',
    `- 源分支：\`${proposal.branch}\`（新建，不会改动你当前检出的分支）`,
    `- 目标分支：\`${proposal.target}\``,
    `- 标题：${proposal.title}`,
    '',
    proposal.files.length ? `**将提交的文件**（${proposal.files.length} 个，+${additions} −${deletions}）：` : '**没有未提交的改动**，只推送下面的本地提交。',
    ...proposal.files.slice(0, fileLimit).map(file => `- \`${file.path}\` +${file.additions} −${file.deletions}${file.change === 'added' ? '（新增）' : file.change === 'deleted' ? '（删除）' : ''}`),
    ...(proposal.files.length > fileLimit ? [`- 另有 ${proposal.files.length - fileLimit} 个文件`] : []),
    ...(proposal.commits.length ? ['', `**一起推送的本地提交**（${proposal.commits.length} 个，还不在 ${proposal.target} 上）：`, ...proposal.commits.slice(0, 10).map(commit => `- ${commit.sha.slice(0, 8)} ${commit.subject}`)] : []),
    ...(proposal.commitsUnverified ? ['', `注意：本地没有 origin/${proposal.target}，无法确认当前提交之前的本地提交是否已在目标分支上，它们可能一起出现在 PR 里。`] : []),
    ...(proposal.excluded.length ? ['', `**不包含**（${proposal.excluded.length} 个，工作区里的未提交改动）：`, ...proposal.excluded.slice(0, fileLimit).map(file => `- \`${file.path}\`：${excludedReasons[file.reason]}`)] : []),
    '',
    '**PR 正文摘要**：',
    ...proposal.bodySummary.split('\n').map(line => `> ${line}`),
    '',
    `确认按钮 ${Math.round((Date.parse(proposal.expiresAt) - Date.parse(proposal.createdAt)) / 60_000)} 分钟内有效。不确认就不会推送任何东西。`
  ].join('\n');
  const button = (id: string, label: string, op: string, type: string) => ({
    tag: 'button', element_id: id, text: { tag: 'plain_text', content: label }, type,
    behaviors: [{ type: 'callback', value: { dutydeck_pr: proposal.id, op } }], margin: '0px'
  });
  return {
    title: '/pr 需要确认',
    markdown,
    elements: [markdownElement('pr_confirm_body', markdown), button('pr_confirm', '确认推送并开 PR', 'confirm', 'primary'), button('pr_cancel', '取消', 'cancel', 'default')]
  };
}
