import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { Banner } from './primitives';

/** 部署后旧页面引用的哈希 chunk 已不存在；各浏览器对动态 import 失败的报错文案不同。 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ChunkLoadError') return true;
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(error.message);
}

const reload = () => window.location.reload();

export type ErrorFallbackProps = { error: unknown; variant: 'page' | 'panel'; onRetry?(): void };

export function ErrorFallback({ error, variant, onRetry }: ErrorFallbackProps) {
  const stale = isChunkLoadError(error);
  // React.lazy 会缓存被拒绝的 import，chunk 失败时「重试」只会原样再抛，只能刷新。
  const action = stale || !onRetry ? { label: '刷新页面', onClick: reload } : { label: '重试', onClick: onRetry };
  const detail = error instanceof Error ? error.message : undefined;
  const banner = <Banner tone={stale ? 'warning' : 'danger'} role="alert" title={stale ? 'Dutydeck 已更新' : variant === 'page' ? '页面出错了' : '这部分内容加载失败'} action={action}>
    {stale ? '当前页面引用的资源已被新版本替换，刷新后即可继续。' : '刷新页面通常可以恢复；反复出现时请附上下面的错误信息反馈。'}
    {!stale && detail && <span className="mt-1 block break-words font-mono">{detail}</span>}
  </Banner>;
  if (variant === 'page') return <main className="grid min-h-[100dvh] place-items-center bg-canvas p-5"><div className="w-full max-w-md">{banner}</div></main>;
  return <div className="p-4">{banner}</div>;
}

type ErrorBoundaryProps = { children: ReactNode; variant?: 'page' | 'panel'; resetKey?: unknown };
type ErrorBoundaryState = { failure: { error: unknown } | null; resetKey: unknown };

/**
 * React 19 遇到未捕获的渲染错误（含懒加载 chunk 被拒绝）会卸载整棵树，页面直接白屏。
 * resetKey 变化时清掉错误，切换会话后不必刷新整页。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failure: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { failure: { error } };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { failure: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[dutydeck] render failed', error, info.componentStack);
  }

  render() {
    const { failure } = this.state;
    if (!failure) return this.props.children;
    const variant = this.props.variant ?? 'panel';
    return <ErrorFallback error={failure.error} variant={variant} onRetry={variant === 'panel' ? () => this.setState({ failure: null }) : undefined}/>;
  }
}

/** 懒加载区域：加载中显示 fallback，chunk 加载或渲染失败时只让这一块降级。 */
export function LazyBoundary({ fallback, resetKey, children }: { fallback: ReactNode; resetKey?: unknown; children: ReactNode }) {
  return <ErrorBoundary resetKey={resetKey}><Suspense fallback={fallback}>{children}</Suspense></ErrorBoundary>;
}
