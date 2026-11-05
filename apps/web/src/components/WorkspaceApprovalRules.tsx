import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, workspaceApprovalRulesApi } from '../api';
import { currentInstance } from '../instance';
import { Banner, Button, Card, Spinner } from './primitives';
import { formatTime } from './SessionInsightShared';

/**
 * 飞书审批卡上点「本工作区允许此类命令」保存的规则。这里只能查看和撤销；新规则只能在审批卡上由机器人所有者或管理员建。
 * 撤销后下一条同类命令立即恢复弹卡。
 */
export function WorkspaceApprovalRules() {
  const client = useQueryClient();
  const key = ['workspace-approval-rules', currentInstance()];
  const query = useQuery({ queryKey: key, queryFn: workspaceApprovalRulesApi.list, retry: false });
  const remove = useMutation({ mutationFn: workspaceApprovalRulesApi.remove, onSuccess: () => client.invalidateQueries({ queryKey: key }) });
  const rules = query.data?.rules ?? [];
  return <Card padding="md" className="mt-4">
    <h4 className="text-body font-semibold text-primary">按工作区允许的命令 · 仅此实例</h4>
    <p className="mt-1 text-caption text-secondary">飞书审批卡上点「本工作区允许此类命令」后保存在这里：同一机器人在同一执行目录里执行这些命令（只带允许的参数）不再弹卡（复合命令每段都要覆盖，高危命令照常弹卡）。规则只看命令文字，例如允许 <code>pnpm test</code> 后，Agent 改了 package.json 里的脚本就能借它执行任意代码。撤销后立即生效。</p>
    {query.isLoading ? <Spinner/> : query.isError
      ? <div className="mt-3"><Banner tone={query.error instanceof ApiError && query.error.status === 403 ? 'warning' : 'danger'} action={{ label: '重试', onClick: () => void query.refetch() }}>
        {query.error instanceof ApiError && query.error.status === 403 ? '安装管理员登录后才能查看和撤销这些规则。' : '读取工作区审批规则失败'}</Banner></div>
      : rules.length === 0 ? <p className="mt-3 text-caption text-subtle">还没有规则。</p>
      : <ul aria-label="工作区审批规则" className="mt-3 divide-y divide-subtle rounded-md border border-subtle">
        {rules.map(rule => <li key={rule.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <code className="text-body text-primary">{rule.pattern}</code>
            <p className="break-all text-caption text-secondary">{rule.workspace}</p>
            <p className="text-caption text-subtle">机器人 {rule.appId}</p>
            <p className="text-caption text-subtle">{rule.createdBy} 于 {formatTime(rule.createdAt)} 设置</p>
          </div>
          <Button variant="secondary" aria-label={`撤销 ${rule.pattern}（${rule.appId}，${rule.workspace}）`} loading={remove.isPending && remove.variables === rule.id} disabled={remove.isPending} onClick={() => remove.mutate(rule.id)}>撤销</Button>
        </li>)}
      </ul>}
    {remove.error && <div className="mt-2"><Banner tone="danger">{remove.error.message}</Banner></div>}
  </Card>;
}
