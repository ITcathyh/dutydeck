import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Check, Copy } from 'lucide-react';
import { Highlight, Prism, themes } from 'prism-react-renderer';

const languageAliases: Record<string, string> = {
  csharp: 'csharp', cs: 'csharp', html: 'markup', js: 'javascript', jsx: 'jsx',
  md: 'markdown', py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', shell: 'bash',
  ts: 'typescript', tsx: 'tsx', xml: 'markup', yml: 'yaml', zsh: 'bash'
};

export function resolveCodeLanguage(className?: string) {
  const requested = /(?:^|\s)language-([\w-]+)/.exec(className ?? '')?.[1]?.toLowerCase() ?? '';
  const normalized = languageAliases[requested] ?? requested;
  return {
    language: normalized && Prism.languages[normalized] ? normalized : 'plain',
    label: requested || 'text'
  };
}

export function isBlockCode(className: string | undefined, children: ReactNode) {
  return Boolean(className?.includes('language-') || String(children).includes('\n'));
}

// 优先 Clipboard API；API 缺失或 writeText 被拒（权限/非安全上下文）时退回 textarea + execCommand。
// 两路都不引入 window.prompt 之类的原生弹窗——Dutydeck 使用自定义 portal 弹窗。
async function copyToClipboard(code: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(code);
      return true;
    } catch {
      // 落到 legacy 路径重试
    }
  }
  return legacyCopy(code);
}

function legacyCopy(code: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  // 临时 textarea 会抢走选区与焦点，先记下以便 finally 还原。
  const activeElement = document.activeElement;
  const selection = document.getSelection();
  const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
  const textarea = document.createElement('textarea');
  textarea.value = code;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    // execCommand 可能返回 false，也可能直接抛错，两种都算复制失败。
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (savedRange && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
    if (activeElement instanceof HTMLElement || activeElement instanceof SVGElement) activeElement.focus();
  }
}

/*
  具名导出：ToolCard 的展开区要复用同一套 prism 高亮 + 语言标签 + 复制按钮，
  而不能把工具输出包成 ```json 再喂给 MarkdownContent——输出里自带三个反引号会炸掉解析。
*/
export const CodeBlock = memo(function CodeBlock({ code, className }: { code: string; className?: string }) {
  const { language, label } = resolveCodeLanguage(className);
  const [feedback, setFeedback] = useState<'success' | 'failure' | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 每次点击递增的请求代数；卸载时再递增使在途 writeText 失效。
  // await 后只有仍持有当前代数的请求才能写 state/建 timer，避免慢请求覆盖新结果或卸载后泄漏 timer。
  const requestSeq = useRef(0);
  useEffect(() => () => {
    requestSeq.current += 1;
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);
  const copy = async () => {
    const seq = ++requestSeq.current;
    const ok = await copyToClipboard(code);
    if (seq !== requestSeq.current) return;
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setFeedback(ok ? 'success' : 'failure');
    // 成功与失败反馈都在 1.5s 后回到“复制”，失败状态下按钮仍可再次点击重试。
    resetTimer.current = setTimeout(() => setFeedback(null), 1_500);
  };
  const copied = feedback === 'success';
  const failed = feedback === 'failure';
  return <div className="code-renderer group/code my-4 overflow-hidden rounded-lg border border-code-border bg-code-surface shadow-panel [contain:layout_paint]">
    {/*
      代码块头部恒在深色底上（--code-surface 双主题都是深色），但语义文字 token 会跟着
      主题翻转：hover:text-on-inverse 在深色主题下是 #17201f，对比度只有 1.1；
      hover:text-primary 在浅色主题下是 #17201f，对比度 1.06。两者都读不了，所以
      hover 只保留背景变化（hover:bg-code-header-hover），不改文字色。
      白色半透明的分隔线/底色/悬浮底暂无对应语义 token，保留原值（遗留项，见报告）。
    */}
    <div className="flex h-9 items-center border-b border-code-header-border bg-code-header-bg px-3 text-meta text-code-header-text">
      <span className="font-mono tracking-wide">{label}</span>
      <button type="button" onClick={() => void copy()} className="ml-auto flex h-8 items-center gap-1.5 rounded-md px-2 font-medium text-code-header-text transition-colors hover:bg-code-header-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-code-header-text" aria-label={copied ? '代码已复制' : failed ? '代码复制失败，点击重试' : '复制代码'}>
        {copied ? <Check size={12}/> : <Copy size={12}/>}<span>{copied ? '已复制' : failed ? '复制失败' : '复制'}</span>
      </button>
    </div>
    <Highlight theme={themes.vsDark} code={code} language={language}>
      {({ className: prismClassName, style, tokens, getLineProps, getTokenProps }) => <pre className={`${prismClassName} code-renderer-scroll m-0 overflow-x-auto px-4 py-3.5 text-caption leading-6`} style={{ ...style, backgroundColor: 'transparent' }}><code>{tokens.map((line, lineIndex) => <span key={lineIndex} {...getLineProps({ line })} className="block min-h-6">{line.map((token, tokenIndex) => <span key={tokenIndex} {...getTokenProps({ token })}/>)}</span>)}</code></pre>}
    </Highlight>
  </div>;
});

const markdownComponents: Components = {
  code({ className, children }) {
    if (isBlockCode(className, children)) return <CodeBlock className={className} code={String(children).replace(/\n$/, '')}/>;
    return <code className="rounded-sm bg-code-inline-bg px-[.32rem] py-[.12rem] font-mono text-[.86em] text-code-inline-text ring-1 ring-inset ring-code-inline-border">{children}</code>;
  },
  pre({ children }) { return <>{children}</>; }
};

export const MarkdownContent = memo(function MarkdownContent({ children }: { children: string }) {
  return <ReactMarkdown components={markdownComponents}>{children}</ReactMarkdown>;
});
