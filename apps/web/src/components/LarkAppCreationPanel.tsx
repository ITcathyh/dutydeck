import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, QrCode } from 'lucide-react';
import { api, type LarkAppCreationJob } from '../api';
import { Banner, Button, Field, Input, Spinner } from './primitives';

const pendingKey = 'dutydeck:lark-app-creation';
type CreationRequest = { requestId: string; name: string };
const terminal = (job?: LarkAppCreationJob) => Boolean(job && ['completed', 'failed', 'cancelled'].includes(job.status));

function readPending(): CreationRequest | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
    if (typeof value?.requestId === 'string' && typeof value?.name === 'string') return value;
  } catch { /* Storage can be unavailable in a private browser session. */ }
  return undefined;
}

function remember(request?: CreationRequest) {
  try {
    if (request) sessionStorage.setItem(pendingKey, JSON.stringify(request));
    else sessionStorage.removeItem(pendingKey);
  } catch { /* The current view still retains its request ID. */ }
}

// randomUUID is unavailable on plain HTTP LAN addresses; getRandomValues works there.
function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function LarkAppCreationPanel({ onCreated, onBusyChange }: {
  onCreated(appId: string, configured: boolean): Promise<void>;
  onBusyChange(busy: boolean): void;
}) {
  const qc = useQueryClient();
  const [request, setRequest] = useState(readPending);
  const [name, setName] = useState(request?.name ?? 'Dutydeck 助手');
  const completedId = useRef('');
  const update = async (job: LarkAppCreationJob) => {
    await qc.cancelQueries({ queryKey: ['lark-app-creation', job.id] });
    qc.setQueryData(['lark-app-creation', job.id], job);
  };
  const start = useMutation({ mutationFn: api.createLarkApp, onSuccess: update });
  const job = useQuery({
    queryKey: ['lark-app-creation', request?.requestId],
    queryFn: () => api.larkAppCreationJob(request!.requestId),
    enabled: Boolean(request) && !start.isPending,
    retry: false,
    refetchInterval: query => terminal(query.state.data) ? false : 1_000,
  });
  const action = useMutation({
    mutationFn: (kind: 'cancel' | 'retry') => kind === 'cancel'
      ? api.cancelLarkAppCreation(request!.requestId)
      : api.retryLarkAppCreation(request!.requestId),
    onSuccess: update,
  });
  const finish = useMutation({
    mutationFn: async (appId: string) => { await onCreated(appId, job.data?.status === 'completed'); remember(); },
  });
  const state = job.data;
  const busy = start.isPending || action.isPending || finish.isPending || Boolean(request && !terminal(state));
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const complete = finish.mutate;
  useEffect(() => {
    if (state?.status !== 'completed' || !state.appId || completedId.current === state.id) return;
    completedId.current = state.id;
    complete(state.appId);
  }, [state, complete]);

  const create = () => {
    const next = request ?? { requestId: requestId(), name: name.trim() };
    remember(next);
    setRequest(next);
    start.mutate(next);
  };
  const reset = () => {
    remember(); setRequest(undefined); completedId.current = '';
    start.reset(); action.reset(); finish.reset();
  };
  const error = action.error ?? finish.error;

  return <section aria-label="一键创建飞书机器人" className="space-y-3 rounded-lg border border-action-border bg-action-soft p-3.5">
    <div>
      <h3 className="text-body font-semibold text-primary">一键创建飞书机器人</h3>
      <p className="mt-1 text-caption text-secondary">用飞书扫码确认后，在所选企业创建应用，自动配置消息权限并发布，再选择执行 Agent。</p>
    </div>
    {!request ? <>
      <Field label="新机器人名称"><Input name="newAppName" value={name} maxLength={50} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (name.trim()) create(); } }} placeholder="例如：研发助手"/></Field>
      <Button variant="primary" icon={<QrCode size={15}/>} disabled={!name.trim()} onClick={create}>扫码创建机器人</Button>
    </> : <>
      <p className="text-caption font-medium text-primary">{request.name}{state?.tenantName && ` · ${state.tenantName}`}{state?.accountName && ` · ${state.accountName}`}</p>
      {(!state || state.status === 'preparing') && <Spinner label="正在准备飞书扫码登录…"/>}
      {state?.status === 'waiting_for_scan' && <div className="flex flex-wrap items-center gap-4">
        {state.qrDataUrl && <img src={state.qrDataUrl} alt="创建机器人：飞书登录二维码" className="h-40 w-40 rounded-md bg-surface"/>}
        <div className="space-y-2 text-caption text-secondary"><p role="status">{state.scanConfirmed ? '已扫码，请在飞书中确认账号和企业' : '请用飞书扫码，确认账号和企业'}</p><p>确认后开始创建，无需手动复制 App ID 或 App Secret。</p></div>
      </div>}
      {state?.status === 'creating' && <Spinner label="正在创建飞书应用并保存凭据…"/>}
      {state?.status === 'configuring' && <Spinner label="应用已创建，正在配置权限、事件和发布版本…"/>}
      {state?.status === 'completed' && <Banner tone="success">应用已创建并完成配置，正在打开 Agent 设置。</Banner>}
      {state?.status === 'failed' && <Banner tone="danger">{state.error ?? '创建未完成'}{state.appId && <div className="mt-1">应用 {state.appId} 已创建，可继续处理这个应用。</div>}</Banner>}
      {state?.status === 'cancelled' && <p role="status" className="text-caption text-secondary">已取消创建，尚未创建飞书应用。</p>}
      {(job.error || start.error) && !state && <Banner tone="warning">暂时无法获取创建进度。重新连接会继续查询本次创建。<Button variant="ghost" loading={start.isPending} onClick={create}>重新连接</Button></Banner>}
      {job.error && state && !terminal(state) && <Banner tone="warning">读取进度失败，正在重新连接；创建任务可能仍在进行。</Banner>}
      {error && <Banner tone="danger">{error.message}</Banner>}
      <div className="flex flex-wrap gap-2">
        {state && ['preparing', 'waiting_for_scan'].includes(state.status) && <Button loading={action.isPending} onClick={() => action.mutate('cancel')}>取消创建</Button>}
        {state?.status === 'failed' && state.retryable && <Button loading={action.isPending} onClick={() => action.mutate('retry')}>重试本次创建</Button>}
        {(state?.status === 'failed' && state.botSaved || state?.status === 'completed' && finish.isError) && state.appId && <Button loading={finish.isPending} onClick={() => finish.mutate(state.appId!)}>继续配置已创建的机器人</Button>}
        {state?.status === 'failed' && <a href={state.appId ? `https://open.larkoffice.com/app/${encodeURIComponent(state.appId)}` : 'https://open.larkoffice.com/app'} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 text-caption font-medium text-action underline">到飞书后台核对应用<ExternalLink size={12}/></a>}
        {state?.status === 'failed' && !state.retryable && <Button variant="ghost" onClick={reset}>已核对，开始新的创建</Button>}
        {state?.status === 'cancelled' && <Button onClick={reset}>重新开始</Button>}
      </div>
      {busy && <p className="text-caption text-subtle">关闭窗口后，可从“新增机器人”继续查看进度。</p>}
    </>}
  </section>;
}
