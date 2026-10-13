import { Fragment, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileDiff, Link2Off, MessageSquarePlus } from 'lucide-react';
import { api, ApiError, type TurnDiffCommentInput, type TurnDiffFile, type TurnDiffLine } from '../api';
import { sessionPath } from '../app-route';
import { useTheme } from '../useTheme';
import { DutydeckIcon } from './ui';
import { Banner, Button, Card, EmptyState, Spinner, Textarea } from './primitives';

type Target = Omit<TurnDiffCommentInput, 'body'>;
type Draft = TurnDiffCommentInput & { code: string };

const statusLabel: Record<TurnDiffFile['status'], string> = { added: '新增', deleted: '删除', modified: '修改', renamed: '改名' };
const placeholderText: Record<NonNullable<TurnDiffFile['placeholder']>, string> = {
  binary: '二进制文件，不显示内容。',
  too_large: '这个文件的改动太大，页面上不显示。',
  omitted: '超出页面显示上限，没有展开。'
};
const linePrefix = { add: '+', del: '-', context: ' ' } as const;
const lineTone = { add: 'bg-success-soft', del: 'bg-danger-soft', context: '' } as const;
/** 删除行按改动前的行号评论，其余按改动后的行号。 */
const targetOf = (path: string, line: TurnDiffLine): Target => line.kind === 'del' ? { path, side: 'old', line: line.oldLine! } : { path, side: 'new', line: line.newLine! };
const sameTarget = (left: Target, right: Target) => left.path === right.path && left.side === right.side && left.line === right.line;
const sideLabel = (side: Target['side']) => side === 'new' ? '' : '（改动前）';

/**
 * 「查看改动」页：一轮任务的改动，按文件折叠，手机上不横向撑破。
 * 点任意一行可以写评论，攒几条一起提交。登录用户提交后直接作为同一会话的新一轮发给 Agent；
 * 只持有分享链接的人提交后只会在飞书原话题里发一张确认卡，由有权限的人决定是否交给 Agent。
 */
export function TurnDiffPage({ sessionId, taskId, shared }: { sessionId: string; taskId: string; shared: boolean }) {
  useTheme();
  const diff = useQuery({ queryKey: ['turnDiff', sessionId, taskId], queryFn: () => api.turnDiff(sessionId, taskId), retry: false });
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editing, setEditing] = useState<Target & { code: string } | null>(null);
  const [text, setText] = useState('');
  const submit = useMutation({
    mutationFn: () => api.submitTurnDiffComments(sessionId, taskId, drafts.map(({ code: _code, ...comment }) => comment)),
    onSuccess: () => setDrafts([])
  });

  if (diff.isPending) return <main className="grid min-h-[100dvh] place-items-center bg-canvas"><Spinner size="sm" label="正在打开改动…"/></main>;
  if (!diff.data) {
    const status = diff.error instanceof ApiError ? diff.error.status : 0;
    const title = [401, 403].includes(status) ? '链接无效或已失效' : status === 404 ? '这一轮没有记录到改动' : status === 410 ? '改动记录已过期' : '暂时打不开改动';
    const description = [401, 403].includes(status) ? '请回到飞书结果卡重新点「查看改动」；如果仍然打不开，请联系机器人管理员。' : diff.error?.message ?? '请稍后刷新重试。';
    return <main className="grid min-h-[100dvh] place-items-center bg-canvas p-5">
      <Card as="section" padding="lg" className="w-full max-w-md"><EmptyState icon={<Link2Off size={22}/>} title={title} description={description}/></Card>
    </main>;
  }

  const { summary, files, truncated, title } = diff.data;
  const startComment = (target: Target, code: string) => { setEditing({ ...target, code }); setText(''); };
  const addComment = () => {
    if (!editing || !text.trim()) return;
    setDrafts(current => [...current.filter(item => !sameTarget(item, editing)), { ...editing, body: text.trim() }]);
    setEditing(null);
    setText('');
  };
  const removeDraft = (target: Target) => setDrafts(current => current.filter(item => !sameTarget(item, target)));

  return <div className="flex min-h-[100dvh] flex-col bg-canvas font-sans text-primary">
    <header className="border-b border-default bg-surface">
      <div className="mx-auto flex w-full max-w-4xl items-center gap-2.5 px-3 py-2 sm:px-5">
        <DutydeckIcon className="h-6 w-6 shrink-0"/>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-title font-semibold text-primary" title={title}>{title ?? '查看改动'}</h1>
          <div className="mt-0.5 text-caption text-subtle">改动 {summary.files} 个文件 <span className="text-success">+{summary.additions}</span> <span className="text-danger">−{summary.deletions}</span>{shared ? ' · 只读查看' : ''}</div>
        </div>
        {!shared && <a className="shrink-0 text-caption text-link underline" href={sessionPath(sessionId)}>回到任务</a>}
      </div>
    </header>
    <main className="mx-auto w-full max-w-4xl flex-1 space-y-3 px-3 py-3 pb-32 sm:px-5">
      {truncated && <Banner tone="warning">改动太多，只展开了前面的文件，其余文件只列出名字。</Banner>}
      {submit.isSuccess && <Banner tone="success">{submit.data.delivery === 'lark_confirmation' ? '评论已发到飞书话题，等有权限的人确认后交给 Agent 修改。' : '评论已作为新一轮请求发给 Agent。'}</Banner>}
      {submit.isError && <Banner tone="danger">提交失败：{submit.error.message}</Banner>}
      {files.length === 0 && <EmptyState icon={<FileDiff size={22}/>} title="这一轮没有改动文件"/>}
      {files.map(file => <details key={file.path} open={files.length <= 8 && !file.placeholder} className="overflow-hidden rounded-md border border-default bg-surface">
        <summary className="flex cursor-pointer items-start gap-2 px-3 py-2 text-caption">
          <span className="shrink-0 rounded-sm bg-muted px-1.5 text-meta text-secondary">{statusLabel[file.status]}</span>
          <span className="min-w-0 flex-1 break-all font-mono text-primary">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
          <span className="shrink-0 text-meta"><span className="text-success">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span></span>
        </summary>
        {file.placeholder
          ? <p className="border-t border-default px-3 py-3 text-caption text-subtle">{placeholderText[file.placeholder]}</p>
          : <div className="border-t border-default font-mono text-meta">
            {file.hunks.map((hunk, hunkIndex) => <Fragment key={hunkIndex}>
              <div className="break-all bg-muted px-3 py-1 text-subtle">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => {
                const target = targetOf(file.path, line);
                const draft = drafts.find(item => sameTarget(item, target));
                const open = editing && sameTarget(editing, target);
                const code = hunk.lines.slice(Math.max(0, lineIndex - 2), lineIndex + 1).map(item => `${linePrefix[item.kind]}${item.text}`).join('\n');
                return <Fragment key={lineIndex}>
                  <button type="button" aria-label={`评论 ${file.path} 第 ${target.line} 行${sideLabel(target.side)}`} onClick={() => startComment(target, code)}
                    className={`flex w-full items-start text-left hover:bg-hover ${lineTone[line.kind]}`}>
                    <span className="w-10 shrink-0 select-none px-1 text-right text-subtle">{line.oldLine ?? ''}</span>
                    <span className="w-10 shrink-0 select-none px-1 text-right text-subtle">{line.newLine ?? ''}</span>
                    <span className="w-4 shrink-0 select-none text-center text-subtle">{linePrefix[line.kind]}</span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2 text-primary">{line.text || ' '}</span>
                  </button>
                  {draft && !open && <div className="flex items-start gap-2 border-y border-default bg-info-soft px-3 py-2 font-sans text-caption">
                    <MessageSquarePlus size={14} className="mt-0.5 shrink-0 text-info"/>
                    <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-primary">{draft.body}</p>
                    <Button size="sm" variant="ghost" onClick={() => removeDraft(target)}>删除</Button>
                  </div>}
                  {open && <div className="space-y-2 border-y border-default bg-surface px-3 py-2 font-sans">
                    <Textarea aria-label={`${file.path} 第 ${target.line} 行的评论`} value={text} maxLength={2000} autoFocus onChange={event => setText(event.target.value)} placeholder="写下这一行要怎么改"/>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>取消</Button>
                      <Button size="sm" variant="primary" disabled={!text.trim()} onClick={addComment}>添加评论</Button>
                    </div>
                  </div>}
                </Fragment>;
              })}
            </Fragment>)}
          </div>}
      </details>)}
    </main>
    {drafts.length > 0 && <footer className="sticky bottom-0 border-t border-default bg-surface">
      <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-3 py-2 sm:px-5">
        <p className="min-w-0 flex-1 text-caption text-secondary">{drafts.length} 条评论待提交 · {shared ? '提交后在飞书话题里发确认卡，有权限的人确认后才交给 Agent' : '提交后作为新一轮请求发给 Agent'}</p>
        <Button variant="primary" loading={submit.isPending} disabled={drafts.length > 20} onClick={() => submit.mutate()}>提交评论</Button>
      </div>
    </footer>}
  </div>;
}
