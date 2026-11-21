import { managedMemoryQuery, projectMemoriesQuery, projectMemoryBindingQuery, queryKeys } from '../queries';
import { sessionPath } from '../app-route';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MemoryManagementEntry, type MemoryPoolView, type Session } from '../api';
import { Button } from './primitives';

type MemoryWriteResult = { entry: MemoryManagementEntry };

/** Explicit scopes only: opening this panel does not bind or migrate anything. */
export function MemoryManagementPanel({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<{ id?: string; content: string; topic: string; fingerprint: string; projectId: string }>();
  const qc = useQueryClient();
  const isLark = session.source === 'lark';
  const web = !session.source || session.source === 'web';
  const projects = useQuery({ ...projectMemoriesQuery(), enabled: open && web });
  const binding = useQuery({ ...projectMemoryBindingQuery(session.id), enabled: open && web });
  const selected = projectId || binding.data?.projectId || '';
  const pool = useQuery({ ...managedMemoryQuery(session.id, selected, query, isLark), enabled: open && (isLark || Boolean(selected)) });
  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey: queryKeys.allManagedMemory() }), qc.invalidateQueries({ queryKey: queryKeys.projectMemories() }), qc.invalidateQueries({ queryKey: queryKeys.projectMemoryBinding(session.id) }), qc.invalidateQueries({ queryKey: queryKeys.sessionMemory(session.id) })]); };
  const action = useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: refresh });
  const save = useMutation({
    mutationFn: async (submitted: NonNullable<typeof draft>): Promise<MemoryWriteResult> => {
      const body = { content: submitted.content, topic: submitted.topic, expectedFingerprint: submitted.fingerprint };
      if (isLark) return api.reviseMemoryPool(session.id, submitted.id!, body) as Promise<MemoryWriteResult>;
      return api.writeProjectMemory(submitted.projectId, body, submitted.id) as Promise<MemoryWriteResult>;
    },
    onSuccess: async (result, submitted) => {
      await refresh();
      const latest = qc.getQueryData<MemoryPoolView>(['managedMemory', session.id, isLark ? '' : submitted.projectId, query]);
      setDraft(current => {
        if (!current || current.projectId !== submitted.projectId || current.id !== submitted.id || current.fingerprint !== submitted.fingerprint) return current;
        if (JSON.stringify(current) === JSON.stringify(submitted)) return undefined;
        return latest ? { ...current, id: result.entry.id, fingerprint: latest.fingerprint } : current;
      });
    },
  });
  if (!isLark && !web) return null;
  const edit = (entry?: MemoryManagementEntry) => {
    save.reset();
    setDraft({ id: entry?.id, content: entry?.content ?? '', topic: entry?.topic ?? 'general', fingerprint: pool.data!.fingerprint, projectId: selected });
  };
  return <aside className="max-h-[50vh] shrink-0 overflow-y-auto rounded-lg border border-default px-4 py-2" aria-label="记忆管理">
    <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>{open ? '收起记忆管理' : '管理记忆'}</Button>
    {open && <div className="mt-2 space-y-2 text-caption">
      {web && <>
        <p>项目记忆只在显式绑定的 Web 会话中共享。新会话、相同目录和 worktree 都不会自动继承；来源文本不授予执行权限。</p>
        <label>查看项目 <select aria-label="查看项目记忆" value={selected} disabled={Boolean(draft)} onChange={event => { setProjectId(event.target.value); setQuery(''); }} className="rounded border border-default bg-surface p-1"><option value="">选择项目</option>{projects.data?.projects.map(project => <option key={project.id} value={project.id}>{project.name}{project.enabled ? '' : '（已关闭）'}</option>)}</select></label>
        <p>本会话绑定：{projects.data?.projects.find(project => project.id === binding.data?.projectId)?.name ?? binding.data?.projectId ?? '无'}</p>
        <Button size="sm" disabled={!selected || action.isPending} onClick={() => action.mutate(() => api.bindProjectMemory(session.id, selected))}>绑定所选项目</Button>{' '}
        <Button size="sm" disabled={!binding.data?.projectId || action.isPending} onClick={() => action.mutate(() => api.bindProjectMemory(session.id, null))}>解除绑定</Button>
        <form onSubmit={event => { event.preventDefault(); action.mutate(async () => { const result = await api.createProjectMemory(name); setProjectId(result.project.id); setName(''); }); }} className="flex gap-2"><input aria-label="新项目记忆名称" placeholder="新项目记忆名称" value={name} maxLength={100} onChange={event => setName(event.target.value)} className="rounded border border-default bg-surface p-1"/><Button type="submit" size="sm" disabled={!name.trim() || action.isPending}>创建项目记忆</Button></form>
        {selected && <Button size="sm" disabled={action.isPending} onClick={() => action.mutate(() => api.setProjectMemoryEnabled(selected, !projects.data?.projects.find(project => project.id === selected)?.enabled))}>{projects.data?.projects.find(project => project.id === selected)?.enabled ? '关闭项目记忆' : '开启项目记忆'}</Button>}
        <p>绑定、解绑和开关从下一轮开始生效；已发给 Agent 的上下文无法撤回。</p>
      </>}
      {(isLark || selected) && <>
        <p>{pool.data?.scope ?? '项目记忆'} · 已保存内容；是否注入取决于当轮预算。</p>
        <input aria-label="搜索记忆" placeholder="搜索当前记忆池" value={query} onChange={event => setQuery(event.target.value)} className="w-full rounded border border-default bg-surface p-1"/>
        {pool.isError && <p role="alert">读取失败：{pool.error.message}</p>}
        {web && pool.data && <Button size="sm" disabled={Boolean(draft)} onClick={() => edit()}>添加记忆</Button>}
        {pool.data?.entries.length === 0 && <p>当前范围没有匹配的记忆。</p>}
        <ul className="space-y-2">{pool.data?.entries.map(entry => <li key={entry.id} className="rounded bg-muted p-2">
          <p className="break-words">{entry.content}</p><p className="text-subtle">{entry.topic} · {entry.id} · {entry.deletedAt ? entry.supersededBy ? '已替换' : '已删除' : '已保存'}{entry.supersedes?.length ? ` · 修订自 ${entry.supersedes.join(', ')}` : ''}</p>
          {entry.origin && <p>{entry.origin.sessionId ? <a href={sessionPath(entry.origin.sessionId)}>{entry.origin.label}</a> : entry.origin.label}</p>}
          {!entry.deletedAt && <><Button variant="ghost" size="sm" disabled={Boolean(draft)} onClick={() => edit(entry)}>修订</Button><Button variant="ghost" size="sm" disabled={action.isPending} onClick={() => action.mutate(() => isLark ? api.removeMemoryPool(session.id, entry.id) : api.removeProjectMemory(selected, entry.id))}>删除</Button></>}
        </li>)}</ul>
        <p className="text-subtle">{pool.data?.historyNotice}</p>
      </>}
      {draft && <form aria-label="修订记忆" onSubmit={event => { event.preventDefault(); save.mutate(draft); }} className="space-y-2">
        <textarea aria-label="记忆正文" value={draft.content} maxLength={1000} onChange={event => setDraft({ ...draft, content: event.target.value })} className="w-full rounded border border-default bg-surface p-2"/>
        <input aria-label="记忆主题" value={draft.topic} onChange={event => setDraft({ ...draft, topic: event.target.value })} className="rounded border border-default bg-surface p-1"/>
        <Button type="submit" size="sm" disabled={!draft.content.trim() || save.isPending}>保存修订</Button>{' '}<Button type="button" size="sm" onClick={() => setDraft(undefined)}>取消</Button>
        {save.isError && <p role="alert">{save.error.message} 草稿已保留。<Button type="button" size="sm" onClick={() => void pool.refetch()}>重新加载</Button><span>请核对最新内容后重新打开编辑；当前草稿不会覆盖新版本。</span></p>}
      </form>}
      {(projects.isError || binding.isError) && <p role="alert">项目记忆需要安装管理员及会话访问权限。</p>}
      {action.isError && <p role="alert">{action.error.message}</p>}
    </div>}
  </aside>;
}
