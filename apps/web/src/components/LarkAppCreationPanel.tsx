import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, QrCode } from 'lucide-react';
import { api, ApiError, type LarkAppCreationJob } from '../api';
import { currentInstance, instanceHomePath } from '../instance';
import { requestId } from '../request-id';
import { Banner, Button, Field, Input, Spinner } from './primitives';

// Older pages kept one record for every instance in the tab, so such a record may belong to any of them.
const legacyKey = 'dutydeck:lark-app-creation';
// A request ID only exists on the instance that started it; never resume or resubmit it elsewhere.
const pendingKey = () => `${legacyKey}:${instanceHomePath(currentInstance())}`;
type CreationRequest = { requestId: string; name: string; forceLogin?: boolean };
type PendingRequest = CreationRequest & { legacy?: boolean };
const terminal = (job?: LarkAppCreationJob) => Boolean(job && ['completed', 'pending_review', 'failed', 'cancelled'].includes(job.status));

function readPending(key: string): CreationRequest | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (typeof value?.requestId === 'string' && typeof value?.name === 'string') return value;
  } catch { /* Storage can be unavailable in a private browser session. */ }
  return undefined;
}

function remember(key: string, request?: CreationRequest) {
  try {
    if (request) sessionStorage.setItem(key, JSON.stringify(request));
    else sessionStorage.removeItem(key);
  } catch { /* The current view still retains its request ID. */ }
}

function initialRequest(): PendingRequest | undefined {
  const own = readPending(pendingKey());
  if (own) return own;
  const legacy = readPending(legacyKey);
  return legacy && { ...legacy, legacy: true };
}

export function LarkAppCreationPanel({ onCreated, onBusyChange }: {
  onCreated(appId: string, configured: boolean, pendingReview?: boolean, slashCommands?: LarkAppCreationJob['slashCommands']): Promise<void>;
  onBusyChange(busy: boolean): void;
}) {
  const qc = useQueryClient();
  const [request, setRequest] = useState(initialRequest);
  const [name, setName] = useState(request?.name ?? 'Dutydeck 助手');
  const [forceLogin, setForceLogin] = useState(false);
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
    mutationFn: (kind: 'cancel' | 'retry' | 'retry-login') => kind === 'cancel'
      ? api.cancelLarkAppCreation(request!.requestId)
      : api.retryLarkAppCreation(request!.requestId, kind === 'retry-login'),
    onSuccess: update,
  });
  const finish = useMutation({
    mutationFn: async (appId: string) => {
      if (job.data?.status === 'pending_review') await onCreated(appId, true, true);
      else await onCreated(appId, job.data?.status === 'completed', false, job.data?.slashCommands);
      forget();
    },
  });
  const state = job.data;
  const missing = job.error instanceof ApiError && job.error.status === 404;
  // An old shared record is not this instance's until this instance reports the job.
  const busy = start.isPending || action.isPending || finish.isPending || Boolean(request && (!request.legacy || state) && !terminal(state));
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!request?.legacy || !state) return;
    const { legacy: _legacy, ...own } = request;
    remember(pendingKey(), own); remember(legacyKey); setRequest(own);
  }, [request, state]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const complete = finish.mutate;
  useEffect(() => {
    if (state?.status !== 'completed' || !state.appId || completedId.current === state.id) return;
    completedId.current = state.id;
    complete(state.appId);
  }, [state, complete]);

  const submit = (next: CreationRequest) => {
    remember(pendingKey(), next);
    setRequest(next);
    start.mutate(next);
  };
  const create = () => submit({ requestId: requestId(), name: name.trim(), forceLogin });
  const forget = () => { remember(pendingKey()); if (request?.legacy) remember(legacyKey); };
  const reset = () => {
    forget(); setRequest(undefined); completedId.current = '';
    start.reset(); action.reset(); finish.reset();
  };
  const error = action.error ?? finish.error;

  return <section aria-label="一键创建飞书机器人" className="space-y-3 rounded-lg border border-action-border bg-action-soft p-3.5">
    <div>
      <h3 className="text-body font-semibold text-primary">一键创建飞书机器人</h3>
      <p className="mt-1 text-caption text-secondary">优先使用本机已登录的飞书账号创建应用，自动配置消息权限并发布，再选择执行 Agent。登录失效时会提示扫码。</p>
    </div>
    {!request ? <>
      <Field label="新机器人名称"><Input name="newAppName" value={name} maxLength={50} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (name.trim()) create(); } }} placeholder="例如：研发助手"/></Field>
      <label className="flex items-center gap-2 text-caption text-secondary"><input type="checkbox" checked={forceLogin} onChange={event => setForceLogin(event.target.checked)}/>使用其他账号，重新扫码登录</label>
      <Button variant="primary" icon={<QrCode size={15}/>} disabled={!name.trim()} onClick={create}>创建机器人</Button>
    </> : <>
      <p className="text-caption font-medium text-primary">{request.name}{state?.tenantName && ` · ${state.tenantName}`}{state?.accountName && ` · ${state.accountName}`}</p>
      {(!state && !job.error || state?.status === 'preparing') && <Spinner label="正在连接飞书开放平台…"/>}
      {state?.status === 'waiting_for_scan' && <div className="flex flex-wrap items-center gap-4">
        {state.qrDataUrl && <img src={state.qrDataUrl} alt="创建机器人：飞书登录二维码" className="h-40 w-40 rounded-md bg-surface"/>}
        <div className="space-y-2 text-caption text-secondary"><p role="status">{state.scanConfirmed ? '已扫码，请在飞书中确认账号和企业' : '请用飞书扫码，确认账号和企业'}</p><p>确认后开始创建，无需手动复制 App ID 或 App Secret。</p></div>
      </div>}
      {state?.status === 'creating' && <Spinner label="正在创建飞书应用并保存凭据…"/>}
      {state?.status === 'configuring' && <Spinner label="应用已创建，正在配置权限、事件和发布版本…"/>}
      {state?.status === 'completed' && <Banner tone="success">应用已创建并完成配置，正在打开 Agent 设置。</Banner>}
      {state?.status === 'pending_review' && <Banner tone="warning">应用已完成配置并提交发布，正在等待飞书管理员审核。可以继续选择 Agent，审核通过后生效。</Banner>}
      {state?.status === 'failed' && <Banner tone="danger">{state.error ?? '创建未完成'}{state.appId && <div className="mt-1">应用 {state.appId} 已创建，可继续处理这个应用。</div>}</Banner>}
      {state?.status === 'cancelled' && <p role="status" className="text-caption text-secondary">已取消创建，尚未创建飞书应用。</p>}
      {job.error && !state && (!missing
        ? <Banner tone="warning">暂时无法获取创建进度，创建可能仍在进行。重新连接只查询本次创建，不会重新发起。<Button variant="ghost" loading={job.isFetching} onClick={() => void job.refetch()}>重新连接</Button></Banner>
        : request.legacy
          ? <Banner tone="warning">这条未完成的创建记录来自旧版页面，当前实例查不到它，可能是在其他实例发起的，请到发起它的实例查看进度。放弃只清除本页记录，不会取消或重新发起创建。<Button variant="ghost" onClick={reset}>放弃此记录</Button></Banner>
          : <Banner tone="warning">当前实例没有这次创建的记录，请求可能没有送达。可以用同一请求重新提交，或放弃此记录后重新创建。<Button variant="ghost" loading={start.isPending} onClick={() => submit(request)}>重新提交本次创建</Button><Button variant="ghost" onClick={reset}>放弃此记录</Button></Banner>)}
      {job.error && state && !terminal(state) && <Banner tone="warning">读取进度失败，正在重新连接；创建任务可能仍在进行。</Banner>}
      {error && <Banner tone="danger">{error.message}</Banner>}
      <div className="flex flex-wrap gap-2">
        {state && ['preparing', 'waiting_for_scan'].includes(state.status) && <Button loading={action.isPending} onClick={() => action.mutate('cancel')}>取消创建</Button>}
        {state?.status === 'failed' && state.retryable && <><Button loading={action.isPending} onClick={() => action.mutate('retry')}>重试本次创建</Button><Button variant="ghost" loading={action.isPending} onClick={() => action.mutate('retry-login')}>重新扫码后重试</Button></>}
        {((state?.status === 'failed' || state?.status === 'pending_review') && state.botSaved || state?.status === 'completed' && finish.isError) && state.appId && <Button loading={finish.isPending} onClick={() => finish.mutate(state.appId!)}>继续配置已创建的机器人</Button>}
        {state?.status === 'pending_review' && state.appId && <a href={`https://open.larkoffice.com/app/${encodeURIComponent(state.appId)}`} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 text-caption font-medium text-action underline">查看审核进度<ExternalLink size={12}/></a>}
        {state?.status === 'failed' && <a href={state.appId ? `https://open.larkoffice.com/app/${encodeURIComponent(state.appId)}` : 'https://open.larkoffice.com/app'} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 text-caption font-medium text-action underline">到飞书后台核对应用<ExternalLink size={12}/></a>}
        {state?.status === 'failed' && !state.retryable && <Button variant="ghost" onClick={reset}>已核对，开始新的创建</Button>}
        {state?.status === 'cancelled' && <Button onClick={reset}>重新开始</Button>}
      </div>
      {busy && <p className="text-caption text-subtle">关闭窗口后，可从“新增机器人”继续查看进度。</p>}
    </>}
  </section>;
}
