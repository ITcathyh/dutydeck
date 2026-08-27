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

const CodeBlock = memo(function CodeBlock({ code, className }: { code: string; className?: string }) {
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
  return <div className="code-renderer group/code my-4 overflow-hidden rounded-xl border border-zinc-700/70 bg-[#18191d] shadow-[0_8px_24px_rgba(24,24,27,.12)] [contain:layout_paint]">
    <div className="flex h-9 items-center border-b border-white/[.07] bg-white/[.025] px-3 text-[10px] text-zinc-400">
      <span className="font-mono tracking-wide">{label}</span>
      <button type="button" onClick={() => void copy()} className="ml-auto flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-zinc-400 transition-colors hover:bg-white/[.07] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500" aria-label={copied ? '代码已复制' : '复制代码'}>
        {copied ? <Check size={12}/> : <Copy size={12}/>}<span>{copied ? '已复制' : '复制'}</span>
      </button>
    </div>
    <Highlight theme={themes.vsDark} code={code} language={language}>
      {({ className: prismClassName, style, tokens, getLineProps, getTokenProps }) => <pre className={`${prismClassName} code-renderer-scroll m-0 overflow-x-auto px-4 py-3.5 text-[12.5px] leading-6`} style={{ ...style, backgroundColor: 'transparent' }}><code>{tokens.map((line, lineIndex) => <span key={lineIndex} {...getLineProps({ line })} className="block min-h-6">{line.map((token, tokenIndex) => <span key={tokenIndex} {...getTokenProps({ token })}/>)}</span>)}</code></pre>}
    </Highlight>
  </div>;
});

const markdownComponents: Components = {
  code({ className, children }) {
    if (isBlockCode(className, children)) return <CodeBlock className={className} code={String(children).replace(/\n$/, '')}/>;
    return <code className="rounded-[.3rem] bg-zinc-100 px-[.32rem] py-[.12rem] font-mono text-[.86em] text-zinc-800 ring-1 ring-inset ring-zinc-200">{children}</code>;
  },
  pre({ children }) { return <>{children}</>; }
};

export const MarkdownContent = memo(function MarkdownContent({ children }: { children: string }) {
  return <ReactMarkdown components={markdownComponents}>{children}</ReactMarkdown>;
});
