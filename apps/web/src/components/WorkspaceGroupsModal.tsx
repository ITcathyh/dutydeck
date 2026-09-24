import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { sessionWorkspaceDirectory, workspaceName, WORKSPACE_GROUP_NAME_MAX_LENGTH } from '@dutydeck/shared';
import { api, type RunSummary, type Session, type WorkspaceOrganizationSnapshot } from '../api';
import { Banner, Button, Dialog, IconButton, Input, Select, Spinner } from './primitives';
import { Trash2, X } from 'lucide-react';

export type WorkspaceGroupsModalProps = {
  open: boolean;
  onClose(): void;
  snapshot?: WorkspaceOrganizationSnapshot;
  loading: boolean;
  error?: Error;
  sessions: Session[];
  summaries: Record<string, RunSummary>;
  onRetry(): void;
};

const QUERY_KEY = ['workspace-groups'];

/** 改名草稿独立存放：snapshot 每 15s 刷新，不能把用户正在输入的名字冲掉。 */
function GroupRenameRow({ groupId, name, busy, onRename, onDelete }: {
  groupId: string;
  name: string;
  busy: boolean;
  onRename(id: string, name: string): void;
  onDelete(id: string): void;
}) {
  const [draft, setDraft] = useState(name);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setDraft(name); }, [name]);
  const trimmed = draft.trim();
  const changed = trimmed !== name && trimmed.length > 0;

  return <div className="flex flex-col gap-2 rounded-md border border-default px-3 py-2.5">
    <div className="flex items-center gap-2">
      <Input
        aria-label={`重命名分组 ${name}`}
        value={draft}
        maxLength={WORKSPACE_GROUP_NAME_MAX_LENGTH}
        disabled={busy}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && changed) onRename(groupId, trimmed); }}
        className="h-9 min-w-0 flex-1"
      />
      <Button size="sm" variant="secondary" disabled={!changed || busy} onClick={() => onRename(groupId, trimmed)}>保存</Button>
      <IconButton label={`删除分组 ${name}`} disabled={busy} onClick={() => setConfirming(true)}><Trash2 size={15}/></IconButton>
    </div>
    {confirming && <div className="flex flex-col gap-2 rounded-md bg-muted px-3 py-2 text-caption text-secondary">
      <span>删除后，任务将按剩余目录规则重新分组；没有规则时按目录自动分组。不会删除任何任务。确认删除？</span>
      <div className="flex gap-2">
        <Button size="sm" variant="danger" disabled={busy} onClick={() => { setConfirming(false); onDelete(groupId); }}>确认删除</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>取消</Button>
      </div>
    </div>}
  </div>;
}

export function WorkspaceGroupsModal({ open, onClose, snapshot, loading, error, sessions, summaries, onRetry }: WorkspaceGroupsModalProps) {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState('');

  // 所有写操作共用一个 mutation：统一 busy / error，天然串行，pending 期间禁掉重复提交。
  const mutation = useMutation({
    mutationFn: (call: () => Promise<WorkspaceOrganizationSnapshot>) => call(),
    // 先撤下在途的定时刷新，避免旧 snapshot 在写结果落地后又回刷一帧。
    onMutate: () => queryClient.cancelQueries({ queryKey: QUERY_KEY }),
    onSuccess: async next => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      queryClient.setQueryData<WorkspaceOrganizationSnapshot>(QUERY_KEY, next);
    }
  });

  const organization = snapshot?.organization;
  const groups = organization?.groups ?? [];
  const busy = mutation.isPending;

  useEffect(() => {
    if (!open) return;
    setNewName('');
    setSelected(new Set());
    setBulkTarget('');
    mutation.reset();
    // 只在弹窗开关时重置；mutation 不应进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const groupNames = useMemo(() => new Map(groups.map(group => [group.id, group.name])), [groups]);

  const directories = useMemo(() => {
    const paths = new Set<string>();
    for (const session of sessions) paths.add(sessionWorkspaceDirectory(session));
    for (const path of Object.keys(organization?.directoryGroups ?? {})) paths.add(path);
    return [...paths].sort();
  }, [sessions, organization]);

  const currentGroupLabel = (session: Session): string => {
    if (!organization) return '按目录自动分组';
    const override = organization.sessionGroups[session.id];
    if (override && groupNames.has(override)) return groupNames.get(override)!;
    const directory = sessionWorkspaceDirectory(session);
    const byDirectory = organization.directoryGroups[directory];
    if (byDirectory && groupNames.has(byDirectory)) return groupNames.get(byDirectory)!;
    return `按目录自动分组 · ${workspaceName(directory)}`;
  };

  const createGroup = () => {
    const name = newName.trim();
    if (!name || busy) return;
    mutation.mutate(() => api.createWorkspaceGroup(name), {
      onSuccess: () => setNewName('')
    });
  };

  const applyToSessions = () => {
    const ids = sessions.map(session => session.id).filter(id => selected.has(id));
    if (ids.length === 0 || busy) return;
    mutation.mutate(
      () => api.assignWorkspaceGroups({ groupId: bulkTarget || null, sessionIds: ids }),
      { onSuccess: () => setSelected(new Set()) }
    );
  };

  const allSelected = sessions.length > 0 && sessions.every(session => selected.has(session.id));
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(sessions.map(session => session.id)));
  };
  const toggleOne = (id: string) => {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const readFailed = Boolean(error) && !snapshot;

  return <Dialog open={open} onClose={onClose} label="整理分组" size="lg" closeOnEscape={!busy} closeOnScrim={!busy}>
    <Dialog.Header>
      <div className="min-w-0">
        <div className="text-body font-semibold text-primary">整理分组</div>
        <div className="mt-0.5 text-caption text-subtle">按项目或用途整理任务，任务的工作目录保持不变。</div>
      </div>
    </Dialog.Header>
    <Dialog.Body className="flex flex-col gap-5">
      {mutation.isError && <Banner tone="danger" title="操作失败" onDismiss={() => mutation.reset()}>
        {(mutation.error as Error).message || '请稍后重试。'}
      </Banner>}
      {readFailed ? <Banner tone="danger" title="读取分组配置失败" action={{ label: '重试', onClick: onRetry, busy: loading }}>
        {error?.message || '暂时无法整理分组。'}
      </Banner> : loading && !snapshot ? <div className="grid place-items-center py-10"><Spinner size="md" label="正在读取分组配置…"/></div> : <>
        <section className="flex flex-col gap-2">
          <h3 className="text-caption font-semibold text-secondary">自定义分组</h3>
          <div className="flex items-center gap-2">
            <Input
              aria-label="新分组名称"
              placeholder="新分组名称"
              value={newName}
              maxLength={WORKSPACE_GROUP_NAME_MAX_LENGTH}
              disabled={busy}
              onChange={event => setNewName(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') createGroup(); }}
              className="h-9 min-w-0 flex-1"
            />
            <Button size="sm" variant="secondary" disabled={!newName.trim() || busy} onClick={createGroup}>创建分组</Button>
          </div>
          {groups.length === 0 && <p className="text-caption text-subtle">还没有自定义分组，先创建一个。</p>}
          {groups.map(group => <GroupRenameRow
            key={group.id}
            groupId={group.id}
            name={group.name}
            busy={busy}
            onRename={(id, name) => mutation.mutate(() => api.renameWorkspaceGroup(id, name))}
            onDelete={id => mutation.mutate(() => api.deleteWorkspaceGroup(id))}
          />)}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-caption font-semibold text-secondary">目录规则</h3>
          <p className="text-caption text-subtle">源目录相同的任务自动同组；绑定到自定义组后，未来该目录的新任务也会自动进入。</p>
          {directories.map(directory => {
            const value = organization?.directoryGroups[directory] && groupNames.has(organization.directoryGroups[directory])
              ? organization!.directoryGroups[directory]
              : '';
            return <div key={directory} className="flex flex-col items-stretch gap-2 rounded-md border border-default px-3 py-2 sm:flex-row sm:items-center">
              <span className="min-w-0 flex-1 break-all text-caption text-primary">{directory}</span>
              <div className="w-full sm:w-44 sm:shrink-0">
                <Select
                  aria-label={`目录规则 ${directory}`}
                  className="h-9"
                  value={value}
                  disabled={busy}
                  onChange={event => {
                    // 值要在事件内捕获：mutationFn 异步执行时受控 select 已被重渲染复位。
                    const groupId = event.target.value || null;
                    mutation.mutate(() => api.assignWorkspaceGroups({ directories: [directory], groupId }));
                  }}
                >
                  <option value="">按目录自动分组</option>
                  {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
                </Select>
              </div>
            </div>;
          })}
          {directories.length === 0 && <p className="text-caption text-subtle">暂无任务目录。</p>}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-caption font-semibold text-secondary">任务（{sessions.length}）</h3>
            <label className="flex items-center gap-1.5 text-caption text-secondary">
              <input type="checkbox" checked={allSelected} disabled={busy || sessions.length === 0} onChange={toggleAll}/>
              全选
            </label>
          </div>
          {sessions.map(session => <label key={session.id} className="flex items-start gap-2 rounded-md border border-default px-3 py-2">
            <input
              type="checkbox"
              className="mt-0.5"
              aria-label={`选择任务 ${session.id}`}
              checked={selected.has(session.id)}
              disabled={busy}
              onChange={() => toggleOne(session.id)}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-1.5 text-caption text-primary">
                <span className="min-w-0 break-all">{summaries[session.id]?.prompt || session.id}</span>
                {session.archivedAt && <span className="rounded bg-muted px-1 py-0.5 text-subtle">已归档</span>}
              </span>
              <span className="break-all text-caption text-subtle">{sessionWorkspaceDirectory(session)}</span>
              <span className="text-caption text-subtle">当前分组：{currentGroupLabel(session)}</span>
            </span>
          </label>)}
          {sessions.length === 0 && <p className="text-caption text-subtle">暂无可整理的任务。</p>}
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-full sm:w-48">
              <Select
                aria-label="批量目标分组"
                className="h-9"
                value={bulkTarget}
                disabled={busy || selected.size === 0}
                onChange={event => setBulkTarget(event.target.value)}
              >
                <option value="">恢复目录规则</option>
                {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
              </Select>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || selected.size === 0}
              loading={busy}
              onClick={applyToSessions}
            >应用到所选任务（{selected.size}）</Button>
            <span className="text-caption text-subtle">选择「恢复目录规则」后，任务将跟随其目录分组。</span>
          </div>
        </section>
      </>}
    </Dialog.Body>
    <Dialog.Footer>
      <Button variant="secondary" disabled={busy} onClick={onClose}><X size={15}/>关闭</Button>
    </Dialog.Footer>
  </Dialog>;
}
