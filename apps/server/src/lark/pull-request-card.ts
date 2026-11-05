import type { PublicPullRequest } from '@dutydeck/shared';
import { escapeCardInline, markdownElement } from './card-elements.js';
import type { LarkCardElement } from './card-renderer.js';
import { pullRequestLimits } from '../pull-requests.js';

const fileLimit = 30;
const excludedReasons = { not_session: '不是本会话改的', changed_after: '本会话改过，之后又被改动，无法确认' } as const;

/**
 * PR 的标题、分支、文件名、提交说明、链接来自 Agent、平台或外部作者：按纯文本放进卡片，`<at>`、链接、强调等 Markdown 都不生效。
 * `<`、`>`、`&` 用 HTML 实体，其余 Markdown 特殊字符加反斜杠；换行压成空格，免得另起列表或引用。
 */
const plain = (value: string) => escapeCardInline(value.replace(/\s+/g, ' ').trim()).replace(/[*_~`[\]()\\#|!]/g, token => `\\${token}`);
/** 行内代码里反斜杠不生效：只做实体转义并换掉反引号。 */
const code = (value: string) => `\`${escapeCardInline(value.replace(/\s+/g, ' ')).replaceAll('`', "'")}\``;
/** 只放行 http(s) 链接，括号和空白编码掉，免得提前结束链接目标。 */
function safeUrl(value: string | undefined) {
  if (!value) return;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href.replace(/[()<>\s]/g, token => `%${token.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`) : undefined;
  } catch { return; }
}

/** `/pr` 的确认卡：列出将推送的内容，确认按钮是推送的唯一入口。 */
export function buildPullRequestConfirmCard(proposal: PublicPullRequest): { title: string; markdown: string; elements: LarkCardElement[] } {
  const additions = proposal.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = proposal.files.reduce((sum, file) => sum + file.deletions, 0);
  const markdown = [
    `**确认后才会把分支推送到 ${plain(proposal.repository)} 并开 PR**（${plain(proposal.providerName)}）`,
    '',
    `- 源分支：${code(proposal.branch)}（新建，不会改动你当前检出的分支）`,
    `- 目标分支：${code(proposal.target)}`,
    `- 标题：${plain(proposal.title)}`,
    '',
    proposal.files.length ? `**将提交的文件**（${proposal.files.length} 个，+${additions} −${deletions}）：` : '**没有未提交的改动**，只推送下面的本地提交。',
    ...proposal.files.slice(0, fileLimit).map(file => `- ${code(file.path)} +${file.additions} −${file.deletions}${file.change === 'added' ? '（新增）' : file.change === 'deleted' ? '（删除）' : ''}`),
    ...(proposal.files.length > fileLimit ? [`- 另有 ${proposal.files.length - fileLimit} 个文件`] : []),
    ...(proposal.commits.length ? ['', `**一起推送的本地提交**（${proposal.commits.length} 个，还不在 ${plain(proposal.target)} 上）：`, ...proposal.commits.slice(0, 10).map(commit => `- ${plain(commit.sha.slice(0, 8))} ${plain(commit.subject)}`), ...(proposal.commits.length > 10 ? [`- 另有 ${proposal.commits.length - 10} 个提交`] : [])] : []),
    ...(proposal.commitsUnverified ? ['', `注意：本地没有 ${plain(`origin/${proposal.target}`)}，无法确认当前提交之前的本地提交是否已在目标分支上，它们可能一起出现在 PR 里。`] : []),
    ...(proposal.excluded.length ? ['', `**不包含**（${proposal.excluded.length} 个，工作区里的未提交改动）：`, ...proposal.excluded.slice(0, fileLimit).map(file => `- ${code(file.path)}：${excludedReasons[file.reason]}`)] : []),
    '',
    '**PR 正文摘要**：',
    ...proposal.bodySummary.split('\n').map(line => `> ${plain(line)}`),
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

/** `/pr follow` 认领成功后的回执：之后按什么规则跟进，带「停止跟进」按钮。 */
export function buildPullRequestFollowCard(pullRequest: PublicPullRequest): { title: string; markdown: string; elements: LarkCardElement[] } {
  const label = plain(pullRequest.pullRequest?.label ?? 'PR');
  const url = safeUrl(pullRequest.pullRequest?.url);
  const markdown = [
    `**已开始跟进 ${label}**（${plain(pullRequest.providerName)}，${plain(pullRequest.repository)}）`,
    '',
    `- 标题：${plain(pullRequest.title)}`,
    `- 分支：${code(pullRequest.branch)} → ${code(pullRequest.target)}`,
    ...(pullRequest.headSha ? [`- 当前提交：${code(pullRequest.headSha.slice(0, 12))}`] : []),
    ...(url ? [`- 链接：[打开](${url})`] : []),
    '',
    `CI 失败最多自动修 ${pullRequestLimits.ciRounds} 轮；认领之后仓库所有者、成员或协作者的新评审意见自动交给 Agent 处理（最多 ${pullRequestLimits.reviewRounds} 轮），其他人的评论发卡片问你。`
      + `修改只在 PR 已有的文件里，以快进方式推到 ${code(pullRequest.branch)}，不 force；有人另外推送了这个分支时停下。PR 合并或关闭后自动停止。`
  ].join('\n');
  return {
    title: `已跟进 ${pullRequest.pullRequest?.label ?? 'PR'}`,
    markdown,
    elements: [markdownElement('pr_follow_body', markdown), {
      tag: 'button', element_id: 'pr_follow_stop', text: { tag: 'plain_text', content: '停止跟进' }, type: 'default',
      behaviors: [{ type: 'callback', value: { dutydeck_pr: pullRequest.id, op: 'stop' } }], margin: '0px'
    }]
  };
}
