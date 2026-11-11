import { useEffect, useRef, useState } from 'react';
import { Dialog } from './primitives';

export type TerminalTextSnapshot = { text: string; selection?: [number, number] };

export function TerminalTextPanel({ snapshot, onClose }: { snapshot: TerminalTextSnapshot; onClose(): void }) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(() => window.visualViewport?.height ?? window.innerHeight);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => setHeight(viewport?.height ?? window.innerHeight);
    viewport?.addEventListener('resize', resize);
    window.addEventListener('resize', resize);
    return () => { viewport?.removeEventListener('resize', resize); window.removeEventListener('resize', resize); };
  }, []);
  useEffect(() => {
    if (!snapshot.selection) return;
    const frame = requestAnimationFrame(() => {
      textRef.current?.focus();
      textRef.current?.setSelectionRange(...snapshot.selection!);
    });
    return () => cancelAnimationFrame(frame);
  }, [snapshot]);
  const copy = async () => {
    const area = textRef.current;
    const selected = area && area.selectionEnd > area.selectionStart ? snapshot.text.slice(area.selectionStart, area.selectionEnd) : snapshot.text;
    try { await navigator.clipboard.writeText(selected); setCopied(true); setFailed(false); }
    catch { setCopied(false); setFailed(true); }
  };
  return <Dialog open onClose={onClose} label="终端纯文本" size="lg">
    <Dialog.Header><div><h2 className="font-semibold text-primary">终端纯文本</h2><p className="text-caption text-secondary">终端选区保持原范围；无选区时补齐当前屏幕的完整逻辑行，可能延伸到屏幕外。文字已合并折行，可选择后复制。</p></div></Dialog.Header>
    <Dialog.Body>
      <textarea ref={textRef} aria-label="可复制的终端文本" readOnly inputMode="none" spellCheck={false} value={snapshot.text} className="h-[40dvh] min-h-16 w-full resize-none whitespace-pre rounded-md border border-default bg-canvas p-3 font-mono text-caption text-primary" style={{ maxHeight: Math.max(64, height - 240) }} onSelect={() => setCopied(false)}/>
      {failed && <p role="alert" className="text-caption text-danger">复制失败，请长按选择文本，使用浏览器的复制菜单。</p>}
      {copied && <p role="status" className="text-caption text-secondary">已复制</p>}
    </Dialog.Body>
    <Dialog.Footer>
      <button type="button" className="min-h-11 rounded-md px-3 text-caption text-secondary" onClick={onClose}>关闭</button>
      <button type="button" className="min-h-11 rounded-md bg-action px-3 text-caption text-on-action" onClick={() => void copy()}>复制文本</button>
    </Dialog.Footer>
  </Dialog>;
}
