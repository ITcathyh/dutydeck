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

/*
  具名导出：ToolCard 的展开区要复用同一套 prism 高亮 + 语言标签 + 复制按钮，
  而不能把工具输出包成 ```json 再喂给 MarkdownContent——输出里自带三个反引号会炸掉解析。
*/
export const CodeBlock = memo(function CodeBlock({ code, className }: { code: string; className?: string }) {
  const { language, label } = resolveCodeLanguage(className);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = code;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1_500);
    } catch { setCopied(false); }
  };
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
      <button type="button" onClick={() => void copy()} className="ml-auto flex h-8 items-center gap-1.5 rounded-md px-2 font-medium text-code-header-text transition-colors hover:bg-code-header-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-code-header-text" aria-label={copied ? '代码已复制' : '复制代码'}>
        {copied ? <Check size={12}/> : <Copy size={12}/>}<span>{copied ? '已复制' : '复制'}</span>
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
