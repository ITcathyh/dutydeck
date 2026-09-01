import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, LogOut, RefreshCw } from 'lucide-react';
import { api, UNAUTHORIZED_EVENT, type BrowserAuthState } from '../api';
import { Banner, Button, Card, Field, Input, Spinner } from './primitives';

export function AuthGate({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<BrowserAuthState>();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const check = useCallback(async () => {
    setChecking(true); setError(undefined);
    try { setAuth(await api.authStatus()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChecking(false); }
  }, []);

  useEffect(() => { void check(); }, [check]);
  useEffect(() => {
    const unauthorized = () => { setAuth({ authenticated: false, required: true }); setToken(''); };
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
  }, []);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) return;
    setSubmitting(true); setError(undefined);
    try { setAuth(await api.login(token.trim())); setToken(''); }
    catch { setError('访问令牌不正确或已轮换，请重新获取后再试。'); }
    finally { setSubmitting(false); }
  };

  const logout = async () => {
    setSubmitting(true); setError(undefined);
    try { setAuth(await api.logout()); setToken(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSubmitting(false); }
  };

  // Spinner 带 label 时自带 role=status + aria-live=polite，加载文案因此进得了可访问树；
  // 原来那行「正在连接 Dockmux…」只是视觉文本，读屏用户听不到页面正在做什么。
  if (checking && !auth) return <main className="grid min-h-[100dvh] place-items-center bg-canvas"><Spinner size="sm" label="正在连接 Dockmux…"/></main>;

  /*
    这一屏刻意没有 Hero、英文 slogan 与背景网格（docs/interaction-design-2026-08-30.md §5.1）：
    登录页只需回答「这是哪台机器、令牌从哪来、怎么填」。原先那层 workbench-grid 装饰还是个
    在 index.css / tokens.css 里根本没有定义的死类名，什么都不渲染。

    卡片走 Card 原语的「无边框 + shadow」（契约 §4 默认无线）：它是浮在 canvas 上的唯一内容块，
    表面色差与投影已经把层次说清楚，再加一圈线是重复表达。Card 的 as 只接受块级容器，
    所以 <form> 套在里面而不是让 Card 变成 form——原语签名 Phase 0 已冻结，不为一个调用点改它。
  */
  if (!auth?.authenticated) return <main className="grid min-h-[100dvh] place-items-center bg-canvas p-5">
    <Card as="section" padding="lg" className="w-full max-w-sm">
      <form onSubmit={login}>
        {/* 40px 方块，圆角按契约 §3「半径 ≈ 高度 / 3.5」取档：40 / 3.5 ≈ 11 → rounded-md（10px）。 */}
        <div className="grid h-10 w-10 place-items-center rounded-md bg-action text-body font-semibold text-on-action">D</div>
        <h1 className="mt-5 text-heading font-semibold tracking-tight text-primary">连接到这台 Dockmux</h1>
        <p className="mt-2 text-body text-secondary">输入 <code className="rounded-sm bg-muted px-1 py-0.5 text-caption">dockmux auth token</code> 显示的访问令牌。登录后凭据保存在 HttpOnly Cookie 中，不会出现在 URL。</p>
        {/*
          Field 把 label 与控件用 id 绑起来（点标签能聚焦输入框），比原先手写的
          <span> + aria-label 少一份要同步的文案副本。原来贴在框里的钥匙图标随之舍弃：
          Field 没有「图标嵌在输入框内」的槽位，而那个图标纯装饰，旁边就是「访问令牌」四个字。
        */}
        <div className="mt-5">
          <Field label="访问令牌">
            <Input required autoFocus type="password" autoComplete="current-password" value={token} onChange={event => setToken(event.target.value)}/>
          </Field>
        </div>
        {error && <div className="mt-3"><Banner tone="danger">{error}</Banner></div>}
        <div className="mt-5"><Button type="submit" variant="primary" fullWidth loading={submitting} disabled={!token.trim()} icon={<KeyRound size={14}/>} className="min-h-10">连接工作台</Button></div>
        {!auth && <div className="mt-3"><Button variant="ghost" fullWidth onClick={() => void check()} icon={<RefreshCw size={12}/>} className="min-h-10">重新检查连接</Button></div>}
      </form>
    </Card>
  </main>;

  /*
    退出钮与错误浮条都是登录后钉在视口角上的常驻控件，取 z-sticky（100，契约 §7）——
    z-toast 是 Toast 专用档，占用它会让真正的 Toast 压不住这两个角标。

    退出钮用 Button 原语而不是继续手写：原先是 32px 高（低于契约 §9 的 40px 下限）、
    药丸形 rounded-full（契约 §3 禁止用在矩形上）、且没有任何 focus-visible 轮廓。
    variant="secondary" 的视觉与原来逐条手写的 border + surface + shadow-card 一致，
    高度、焦点环、禁用态一并由原语兜住。字号随之从 11px 变成原语的 text-body（14px）——
    契约 §2 本就规定 text-body 是「所有交互控件的默认字号」，这里不再手工压小。
  */
  return <>{children}
    {auth.required && <Button variant="secondary" disabled={submitting} onClick={() => void logout()} icon={<LogOut size={12}/>} title="清除这台浏览器的远程访问凭据" className="fixed bottom-3 right-3 z-sticky min-h-10 backdrop-blur">退出远程访问</Button>}
    {error && <div className="fixed bottom-14 right-3 z-sticky max-w-xs rounded-md shadow-panel"><Banner tone="danger">{error}</Banner></div>}
  </>;
}
