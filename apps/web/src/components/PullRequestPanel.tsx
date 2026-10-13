import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PublicPullRequest, PullRequestStatus } from '@dutydeck/shared';
import { api, type Session } from '../api';
import { Banner, Button, Dialog, Field, Input } from './primitives';

const statusLabels: Record<PullRequestStatus, string> = { proposed: '等待确认', pushing: '推送中', open: '跟进中', merged: '已合并', closed: '已关闭', stopped: '已停止跟进', cancelled: '已取消', expired: '确认已过期', failed: '失败' };
const excludedReasons = { not_session: '不是本会话改的', changed_after: '本会话改过，之后又被改动，无法确认' } as const;

/** 把本会话的改动推到 dutydeck/ 新分支并开 PR：先出确认框，确认后才推送。 */
export function PullRequestPanel({ session }: { session: Session }) {
  const qc = useQueryClient();
  const queryKey = ['pullRequests', session.id];
  const records = useQuery({ queryKey, queryFn: () => api.pullRequests(session.id), retry: false, refetchInterval: query => query.state.error ? false : 10_000 });
  const [title, setTitle] = useState('');
  const [proposal, setProposal] = useState<PublicPullRequest>();
  const [notice, setNotice] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey });
  const prepare = useMutation({ mutationFn: () => api.preparePullRequest(session.id, title.trim() ? { title: title.trim() } : {}), onSuccess: result => { setNotice(''); setProposal(result.pullRequest); void refresh(); } });
  const confirm = useMutation({ mutationFn: (id: string) => api.confirmPullRequest(session.id, id), onSuccess: result => { setProposal(undefined); setTitle(''); setNotice(result.message); void refresh(); } });
  const cancel = useMutation({ mutationFn: (id: string) => api.cancelPullRequest(session.id, id), onSettled: () => { setProposal(undefined); void refresh(); } });
  const readOnly = Boolean(session.archivedAt) || ['stopped', 'failed'].includes(session.state);
  const data = records.data;
  const error = records.error ?? prepare.error ?? cancel.error;
  const additions = proposal?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const deletions = proposal?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;

  return <section className="space-y-3">
    <h3 className="text-body font-semibold">开 PR</h3>
    <p className="text-caption text-secondary">把本会话改过的文件提交到新的 dutydeck/ 分支并开 PR，之后自动跟进 CI 失败和评审意见。确认前不推送；不会切换或改写你当前检出的分支。</p>
    {error && <Banner tone="danger">{error.message}</Banner>}
    {notice && <p role="status" className="text-caption text-secondary">{notice}</p>}
    {data && !data.available && <p className="text-caption text-secondary">{data.hint}</p>}
    {data?.available && !readOnly && <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); prepare.mutate(); }}>
      <div className="min-w-0 flex-1"><Field label="PR 标题（可选）"><Input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} placeholder="留空用任务名"/></Field></div>
      <Button type="submit" variant="primary" loading={prepare.isPending}>开 PR</Button>
    </form>}
    {data?.items.map(item => <div key={item.id} className="rounded-lg border border-default p-3 text-caption">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>{statusLabels[item.status]} · {item.title}</strong>
        {!readOnly && item.status === 'proposed' && <Button onClick={() => setProposal(item)}>查看并确认</Button>}
        {!readOnly && item.status === 'open' && <Button disabled={cancel.isPending} onClick={() => cancel.mutate(item.id)}>停止跟进</Button>}
      </div>
      <p className="mt-1 break-all text-secondary">{item.providerName} · {item.repository} · {item.branch} → {item.target}{item.pullRequest && <> · <a className="text-link" href={item.pullRequest.url} target="_blank" rel="noreferrer">{item.pullRequest.label}</a></>}</p>
      {(item.ciRounds > 0 || item.reviewRounds > 0) && <p className="text-subtle">已自动修 CI {item.ciRounds} 轮、处理评审意见 {item.reviewRounds} 轮</p>}
      {item.reason && <p className={item.status === 'failed' || item.status === 'stopped' ? 'text-warning' : 'text-subtle'}>{item.reason}</p>}
    </div>)}
    {proposal && <Dialog open onClose={() => cancel.mutate(proposal.id)} label="确认推送并开 PR" size="md" role="alertdialog" closeOnEscape={!confirm.isPending && !cancel.isPending} closeOnScrim={!confirm.isPending && !cancel.isPending}>
      <Dialog.Header><h2 className="text-title font-semibold">确认推送并开 PR</h2></Dialog.Header>
      <Dialog.Body>
        <div className="space-y-3 text-caption">
          <p className="text-secondary">确认后才会推送并开 PR（{proposal.providerName}，{proposal.repository}）。</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-subtle">源分支</dt><dd className="break-all font-mono">{proposal.branch}（新建）</dd>
            <dt className="text-subtle">目标分支</dt><dd className="break-all font-mono">{proposal.target}</dd>
            <dt className="text-subtle">标题</dt><dd>{proposal.title}</dd>
          </dl>
          <div>
            <h3 className="font-semibold">{proposal.files.length ? `将提交的文件（${proposal.files.length} 个，+${additions} −${deletions}）` : '没有未提交的改动，只推送下面的本地提交'}</h3>
            <ul aria-label="将提交的文件" className="mt-1 max-h-48 space-y-0.5 overflow-auto font-mono">
              {proposal.files.map(file => <li key={file.path} className="break-all">{file.path} <span className="text-success">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span>{file.change === 'added' ? '（新增）' : file.change === 'deleted' ? '（删除）' : ''}</li>)}
            </ul>
          </div>
          {!!proposal.commits.length && <div>
            <h3 className="font-semibold">一起推送的本地提交（{proposal.commits.length} 个，还不在 {proposal.target} 上）</h3>
            <ul className="mt-1 space-y-0.5 font-mono">{proposal.commits.map(commit => <li key={commit.sha} className="break-all">{commit.sha.slice(0, 8)} {commit.subject}</li>)}</ul>
          </div>}
          {proposal.commitsUnverified && <Banner tone="warning">本地没有 origin/{proposal.target}，无法确认当前提交之前的本地提交是否已在目标分支上，它们可能一起出现在 PR 里。</Banner>}
          {!!proposal.excluded.length && <div>
            <h3 className="font-semibold">不包含（{proposal.excluded.length} 个，工作区里的未提交改动）</h3>
            <ul aria-label="不包含的文件" className="mt-1 max-h-32 space-y-0.5 overflow-auto">{proposal.excluded.map(file => <li key={file.path} className="break-all"><span className="font-mono">{file.path}</span>：{excludedReasons[file.reason]}</li>)}</ul>
          </div>}
          <div>
            <h3 className="font-semibold">PR 正文摘要</h3>
            <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-muted p-2">{proposal.bodySummary}</pre>
          </div>
          {confirm.error && <Banner tone="danger">{confirm.error.message}</Banner>}
        </div>
      </Dialog.Body>
      <Dialog.Footer>
        <Button data-dialog-initial-focus disabled={confirm.isPending || cancel.isPending} onClick={() => cancel.mutate(proposal.id)}>取消</Button>
        <Button variant="primary" loading={confirm.isPending} disabled={cancel.isPending} onClick={() => confirm.mutate(proposal.id)}>确认推送并开 PR</Button>
      </Dialog.Footer>
    </Dialog>}
  </section>;
}
