import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api, type Session, type Task, type WorkspaceCleanupPreview } from '../api';
import { Banner, Button, Dialog, Field, IconButton, Input, Spinner } from './primitives';
import { SessionAutomationPanel } from './SessionAutomationPanel';

import { verificationLabel } from './verification-presentation';

export function SessionDeliveryPanel({ session, tasks, onClose }: { session: Session; tasks: Task[]; onClose(): void }) {
  const qc = useQueryClient();
  const [command, setCommand] = useState('');
  const [cleanupPreview, setCleanupPreview] = useState<WorkspaceCleanupPreview | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  const capabilities = useQuery({ queryKey: ['sessionCapabilities', session.id], queryFn: () => api.sessionCapabilities(session.id) });
  const workspace = useQuery({ queryKey: ['workspace', session.id], queryFn: () => api.workspace(session.id) });
  const evidence = useQuery({ queryKey: ['verifications', session.id], queryFn: () => api.verifications(session.id), refetchInterval: 5_000 });
  const verify = useMutation({ mutationFn: () => api.verify(session.id, { command: command.trim() }), onSettled: () => { void qc.invalidateQueries({ queryKey: ['verifications', session.id] }); } });

  const checkCleanup = useMutation({
    mutationFn: () => api.workspaceCleanupPreview(session.id),
    onSuccess: data => {
      setCleanupPreview(data);
      setCleanupError(null);
      if (data.cleanedAt) {
        void qc.invalidateQueries({ queryKey: ['workspace', session.id] });
      }
    },
    onError: err => {
      setCleanupError(err instanceof Error ? err.message : String(err));
    }
  });

  const executeCleanup = useMutation({
    mutationFn: (fingerprint: string) => api.cleanWorkspace(session.id, fingerprint),
    onSuccess: () => {
      setCleanupPreview(null);
      setCleanupError(null);
      void qc.invalidateQueries({ queryKey: ['workspace', session.id] });
    },
    onError: err => {
      setCleanupError(err instanceof Error ? err.message : String(err));
    }
  });

  const readOnly = Boolean(session.archivedAt) || ['stopped', 'failed'].includes(session.state);
  const verificationUnavailable = capabilities.data?.verification === 'unavailable';
  const busy = verificationUnavailable || ['thinking', 'running_tool', 'waiting_for_permission', 'interrupting'].includes(session.state) || verify.isPending || evidence.data?.some(record => record.status === 'running');
  const skillTasks = tasks.filter(task => task.skillDeliveries?.length);

  const isArchivedWorktree = Boolean(session.archivedAt) && workspace.data?.mode === 'worktree';
  const isCleaned = workspace.data?.state === 'cleaned' || Boolean(workspace.data?.cleanedAt);

  return <Dialog open onClose={onClose} label="工作目录与自动化" size="lg">
    <Dialog.Header><h2 className="text-title font-semibold">工作目录与自动化</h2><span className="ml-auto"><IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton></span></Dialog.Header>
    <Dialog.Body>
      <div className="space-y-6">
        <section className="space-y-2">
          <h3 className="text-body font-semibold">工作目录</h3>
          {workspace.isLoading && <Spinner label="读取工作目录"/>}
          {workspace.error && <Banner tone="danger">{workspace.error.message}</Banner>}
          {isCleaned ? (
            <div className="space-y-2">
              <Banner tone="info">工作目录已清理，任务历史仍可读。已保留分支 {workspace.data?.branch} 及提交历史。</Banner>
              <p className="break-all font-mono text-caption text-subtle">原目录：{workspace.data?.cwd ?? session.cwd}</p>
            </div>
          ) : (
            <>
              <p className="break-all font-mono text-caption">{workspace.data?.cwd ?? session.cwd}</p>
              {workspace.data && <p className="text-caption text-secondary">{workspace.data.mode === 'worktree' ? '独立 Git 工作目录' : '直接使用目录'} · {workspace.data.state === 'ready' ? '已准备' : workspace.data.state === 'failed' ? '准备失败' : '准备中'}{workspace.data.branch ? ` · ${workspace.data.branch}` : ''}</p>}
              {workspace.data?.baselineCommit && <p className="text-caption text-subtle">基线提交 {workspace.data.baselineCommit.slice(0, 12)}；归档后仍保留工作目录。</p>}
              {workspace.data?.error && <Banner tone="danger">{workspace.data.error}</Banner>}
              {isArchivedWorktree && (
                <div className="mt-3 rounded-lg border border-default p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-caption font-semibold">独立工作目录清理</h4>
                      <p className="text-caption text-secondary">仅删除独立工作目录，保留 Git 分支与历史提交记录。</p>
                    </div>
                    {!cleanupPreview && (
                      <Button
                        variant="secondary"
                        onClick={() => { setCleanupError(null); checkCleanup.mutate(); }}
                        loading={checkCleanup.isPending}
                      >
                        检查可否清理
                      </Button>
                    )}
                  </div>
                  {cleanupError && <Banner tone="danger">{cleanupError}</Banner>}
                  {checkCleanup.isPending && <Spinner label="检查工作目录可否安全清理..."/>}
                  {cleanupPreview && (
                    <div className="space-y-3">
                      <div className="text-caption space-y-1 text-secondary">
                        <p>将删除目录：<span className="font-mono text-primary">{cleanupPreview.path}</span></p>
                        <p>将保留分支与提交历史：<span className="font-mono text-primary">{cleanupPreview.branch ?? workspace.data?.branch}</span></p>
                      </div>
                      {cleanupPreview.canClean ? (
                        <div className="space-y-2">
                          <Banner tone="info">工作目录状态干净，无未提交改动或新增未推送提交，可安全清理。</Banner>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="danger"
                              onClick={() => executeCleanup.mutate(cleanupPreview.fingerprint)}
                              loading={executeCleanup.isPending}
                            >
                              确认清理工作目录
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => { setCleanupError(null); checkCleanup.mutate(); }}
                              disabled={executeCleanup.isPending}
                            >
                              重新检查
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="space-y-1 rounded border border-warning/30 bg-warning/10 p-2 text-caption">
                            <p className="font-medium text-warning">当前无法清理工作目录：</p>
                            <ul className="list-inside list-disc space-y-1 text-secondary">
                              {cleanupPreview.blockers.map((b, i) => (
                                <li key={i}>
                                  <span>{b.message}</span>
                                  {b.details && b.details.length > 0 && (
                                    <div className="mt-1 max-h-24 overflow-auto font-mono text-caption text-subtle">
                                      {b.details.map((detail, j) => <div key={j}>{detail}</div>)}
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                          <Button
                            variant="secondary"
                            onClick={() => { setCleanupError(null); checkCleanup.mutate(); }}
                            loading={checkCleanup.isPending}
                          >
                            重新检查
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
        <section className="space-y-2">
          <h3 className="text-body font-semibold">当前连接能力</h3>
          {capabilities.error && <Banner tone="danger">{capabilities.error.message}</Banner>}
          {capabilities.data && <p className="text-caption text-secondary">{Object.entries({ structuredApproval: '结构化审批', terminal: '终端输入', localFileDelivery: '本地文件回传平台支持' }).map(([key, label]) => `${label}：${({ available: '可用', unavailable: '不可用', unverified: '尚未验证' } as Record<string, string>)[capabilities.data![key as 'terminal']] ?? '尚未验证'}`).join(' · ')}</p>}
          <p className="text-caption text-subtle">运行中恢复还需原生输出游标和原终端身份匹配；重启时验证，当前不保证可恢复。</p>
        </section>
        <section className="space-y-3">
          <h3 className="text-body font-semibold">验证证据</h3>
          <p className="text-caption text-secondary">在上面的目录执行你填写的命令，记录退出码与输出。验证结果独立于 Agent 的执行状态；代码变化后需要重新验证。</p>
          {!readOnly && <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); if (command.trim() && !busy) verify.mutate(); }}>
            <div className="min-w-0 flex-1"><Field label="验证命令"><Input value={command} onChange={event => setCommand(event.target.value)} placeholder="例如 pnpm test" maxLength={4096} disabled={busy}/></Field></div>
            <Button type="submit" variant="primary" disabled={!command.trim() || busy} loading={verify.isPending}>执行验证</Button>
          </form>}
          {verificationUnavailable && <Banner tone="warning">平台验证当前需要 Linux，才能在服务异常退出后确认并清理原验证进程。</Banner>}
          {busy && !verificationUnavailable && <p className="text-caption text-subtle">本会话正在执行，结束后可启动验证。</p>}
          {(verify.error || evidence.error) && <Banner tone="danger">{(verify.error ?? evidence.error)?.message}</Banner>}
          {evidence.isLoading ? <Spinner label="读取验证记录"/> : !evidence.error && !evidence.data?.length && <p className="text-caption text-subtle">尚无平台执行的验证记录。</p>}
          {evidence.data?.map(record => <details key={record.id} className="rounded-lg border border-default p-3">
            <summary className="cursor-pointer text-caption"><strong>{verificationLabel(record)}</strong> · {record.command}</summary>
            <p className="mt-2 text-caption text-subtle">{new Date(record.startedAt).toLocaleString()} · {record.exitCode === undefined ? '无退出码' : `退出码 ${record.exitCode}`}</p>
            {record.error && <p className="mt-1 text-caption text-danger">{record.error}</p>}
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-caption">{record.output || '无命令输出'}</pre>
            {record.outputTruncated && <p className="text-caption text-warning">输出超过记录上限，已截断。</p>}
          </details>)}
        </section>
        <SessionAutomationPanel session={session} taskTitle={tasks.find(task => task.prompt.trim())?.prompt}/>
        <section className="space-y-2">
          <h3 className="text-body font-semibold">Skill 投递记录</h3>
          {!skillTasks.length && <p className="text-caption text-subtle">尚无明确选中的 Skill。发送时可在输入框选择。</p>}
          {skillTasks.map(task => <details key={task.id} className="rounded-lg border border-default p-3"><summary className="cursor-pointer text-caption">{task.prompt.slice(0, 100)} · {task.skillDeliveries!.length} 项</summary>
            {task.skillDeliveries!.map(skill => <div key={skill.path} className="mt-2 break-all text-caption"><strong>{skill.name}</strong> · 正文已加入本轮指令<p className="text-subtle">{skill.source === 'workspace' ? '项目' : '个人'} · {skill.path}<br/>SHA256 {skill.digest}</p></div>)}
          </details>)}
        </section>
      </div>
    </Dialog.Body>
  </Dialog>;
}
