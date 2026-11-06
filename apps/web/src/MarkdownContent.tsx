import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import { Check, Copy } from 'lucide-react';
import { Highlight, Prism, themes } from 'prism-react-renderer';
import { isIndexColumn, isSequenceColumn, nowrapColumns } from './share-view';
import { copyToClipboard } from './clipboard';

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
  pre({ children }) { return <>{children}</>; },
  table({ children }) { return <div className="markdown-table-scroll" role="region" aria-label="表格，可横向滚动" tabIndex={0}><table>{children}</table></div>; }
};

type MarkdownNode = { type: string; value?: string; align?: Array<string | null>; children?: MarkdownNode[]; data?: { hName?: string; hProperties?: Record<string, unknown>; hChildren?: unknown[] } };
const nodeText = (node: MarkdownNode): string => node.type === 'break' ? '\n' : node.value ?? (node.children ?? []).map(nodeText).join('');
const withProperties = (node: MarkdownNode, properties: Record<string, unknown>) => { node.data = { ...node.data, hProperties: { ...node.data?.hProperties, ...properties } }; };
const visitNodes = (node: MarkdownNode, visit: (node: MarkdownNode) => void) => { visit(node); node.children?.forEach(child => visitNodes(child, visit)); };

/** Agent 常在表格单元格里写 `<br>` 换行。不开启原始 HTML，只把这一种标签当作换行。 */
function remarkHtmlBreaks() {
  return (tree: unknown) => visitNodes(tree as MarkdownNode, node => {
    node.children?.forEach((child, index) => { if (child.type === 'html' && /^<br\s*\/?>$/i.test(child.value?.trim() ?? '')) node.children![index] = { type: 'break' }; });
  });
}

/** 单元格里的长路径、文件名只在 / . _ - 之后断开；<wbr> 不进入复制出的文字。 */
const breakable = /[^\s]{17,}/g;
function breakPieces(value: string): Array<{ text: string } | { wbr: true }> {
  const pieces: Array<{ text: string } | { wbr: true }> = [];
  let last = 0;
  for (const match of value.matchAll(breakable)) {
    const token = match[0];
    const at = match.index!;
    for (const point of token.matchAll(/(?<=.)[/._-](?=.)/g)) {
      const cut = at + point.index! + 1;
      pieces.push({ text: value.slice(last, cut) }, { wbr: true });
      last = cut;
    }
  }
  pieces.push({ text: value.slice(last) });
  return pieces;
}
function insertBreaks(cell: MarkdownNode) {
  visitNodes(cell, node => {
    if (node.type === 'inlineCode' && node.value) {
      const pieces = breakPieces(node.value);
      if (pieces.length > 1) node.data = { ...node.data, hChildren: pieces.map(piece => 'text' in piece ? { type: 'text', value: piece.text } : { type: 'element', tagName: 'wbr', properties: {}, children: [] }) };
    }
    if (!node.children?.some(child => child.type === 'text')) return;
    node.children = node.children.flatMap(child => child.type !== 'text' || !child.value ? [child]
      : breakPieces(child.value).map(piece => 'text' in piece ? { type: 'text', value: piece.text } : { type: 'shareBreak', data: { hName: 'wbr' } }));
  });
}

/*
  分享页的结论排版：首段是段落时标成导语。表格每个单元格带上对应表头（窄屏把一行排成一张小卡时显示列名），
  序号列、第一个非序号列和数值列分别标出，供窄屏合成卡片标题行：标题在左、数值在右；序号恰好是 1..n 时窄屏不显示。
  数值列是标题列之外第一个整列不折行且右对齐的列。短列整列不折行，长列拿到剩余宽度。
  任意列数的表格都适用，不看单元格内容的语义。
*/
function remarkShareLayout() {
  return (tree: unknown) => {
    const root = tree as MarkdownNode;
    if (root.children?.[0]?.type === 'paragraph') withProperties(root.children[0], { className: ['share-lead'] });
    visitNodes(root, node => {
      if (node.type !== 'table') return;
      const [header, ...rows] = node.children ?? [];
      const labels = (header?.children ?? []).map(cell => nodeText(cell).trim());
      const columns = labels.map((label, index) => [label, ...rows.map(row => nodeText(row.children?.[index] ?? { type: 'text', value: '' }))]);
      const nowrap = nowrapColumns(columns);
      const indexColumn = labels.length > 1 && isIndexColumn(labels[0]!, columns[0]!.slice(1)) ? 0 : -1;
      const titleColumn = indexColumn + 1;
      const valueColumn = labels.findIndex((_, index) => index !== indexColumn && index !== titleColumn && nowrap[index] && node.align?.[index] === 'right');
      const sequence = indexColumn === 0 && isSequenceColumn(columns[0]!.slice(1));
      for (const row of [header, ...rows]) row?.children?.forEach((cell, index) => {
        const className = [nowrap[index] && 'share-nowrap', index === indexColumn && 'share-cell-index', index === indexColumn && sequence && 'share-cell-seq',
          index === titleColumn && 'share-cell-title', index === valueColumn && 'share-cell-value'].filter(Boolean);
        withProperties(cell, { ...(className.length ? { className } : {}), ...(row !== header && labels[index] ? { dataLabel: labels[index] } : {}) });
        insertBreaks(cell);
      });
    });
  };
}

const shareComponents: Components = {
  ...markdownComponents,
  // 分享页只读：外链在新窗口打开，不把读者带离结论。
  a({ href, children }) {
    const external = /^https?:\/\//i.test(href ?? '');
    return <a href={href} className={external ? 'share-ext' : undefined} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>{children}</a>;
  },
  table({ children }) { return <div className="share-table" role="region" aria-label="表格" tabIndex={0}><table>{children}</table></div>; }
};

// remark-cjk-friendly：让 `**「抖动」**，` 这类紧挨中文标点的强调也能成立（CommonMark 的定界规则会拒绝它）。
const remarkPlugins = [remarkGfm, remarkCjkFriendly, remarkHtmlBreaks];
const shareRemarkPlugins = [...remarkPlugins, remarkShareLayout];

export const MarkdownContent = memo(function MarkdownContent({ children, variant }: { children: string; variant?: 'share' }) {
  if (variant === 'share') return <ReactMarkdown remarkPlugins={shareRemarkPlugins} components={shareComponents}>{children}</ReactMarkdown>;
  return <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>{children}</ReactMarkdown>;
});
