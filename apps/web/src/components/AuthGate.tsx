import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, LoaderCircle, LogOut, RefreshCw } from 'lucide-react';
import { api, UNAUTHORIZED_EVENT, type BrowserAuthState } from '../api';

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

  if (checking && !auth) return <main className="grid min-h-[100dvh] place-items-center bg-[var(--canvas)] text-slate-600"><div className="flex items-center gap-2 text-sm"><LoaderCircle size={16} className="animate-spin"/>正在连接 Dockmux…</div></main>;

  if (!auth?.authenticated) return <main className="relative grid min-h-[100dvh] place-items-center overflow-hidden bg-[var(--canvas)] p-5">
    <div aria-hidden="true" className="workbench-grid absolute inset-0 opacity-70"/>
    <form onSubmit={login} className="relative w-full max-w-sm rounded-2xl border border-slate-200 bg-[var(--paper)] p-6 shadow-[0_24px_80px_rgba(15,23,42,.16)]">
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-teal-700 text-sm font-bold text-white">D</div>
      <div className="mt-5 text-[10px] font-semibold uppercase tracking-[.18em] text-teal-700">Remote workspace</div>
      <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">连接到这台 Dockmux</h1>
      <p className="mt-2 text-sm leading-6 text-slate-600">输入 <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">dockmux auth token</code> 显示的访问令牌。登录后凭据保存在 HttpOnly Cookie 中，不会出现在 URL。</p>
      <label className="mt-5 block"><span className="text-xs font-semibold text-slate-800">访问令牌</span><span className="mt-1.5 flex items-center rounded-xl border border-slate-300 bg-white px-3 focus-within:border-teal-600 focus-within:ring-1 focus-within:ring-teal-600"><KeyRound size={14} className="shrink-0 text-slate-400"/><input required autoFocus type="password" autoComplete="current-password" aria-label="访问令牌" value={token} onChange={event => setToken(event.target.value)} className="h-11 min-w-0 flex-1 border-0 bg-transparent px-2 text-sm outline-none"/></span></label>
      {error && <p role="alert" className="mt-3 text-xs leading-5 text-rose-700">{error}</p>}
      <button type="submit" disabled={submitting || !token.trim()} className="mt-5 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-teal-700 text-sm font-semibold text-white hover:bg-teal-600 disabled:opacity-50">{submitting ? <LoaderCircle size={14} className="animate-spin"/> : <KeyRound size={14}/>}连接工作台</button>
      {!auth && <button type="button" onClick={() => void check()} className="mt-3 flex w-full items-center justify-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"><RefreshCw size={12}/>重新检查连接</button>}
    </form>
  </main>;

  return <>{children}{auth.required && <button type="button" disabled={submitting} onClick={() => void logout()} className="fixed bottom-3 right-3 z-50 flex h-8 items-center gap-1.5 rounded-full border border-slate-200 bg-white/90 px-3 text-[11px] font-medium text-slate-500 shadow-sm backdrop-blur hover:text-slate-900 disabled:opacity-50" title="清除这台浏览器的远程访问凭据"><LogOut size={12}/>退出远程访问</button>}{error && <div role="alert" className="fixed bottom-14 right-3 z-50 max-w-xs rounded-lg bg-rose-700 px-3 py-2 text-xs text-white shadow-lg">{error}</div>}</>;
}
