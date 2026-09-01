import { useRef, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { parseMemberNames } from './ui';

export function MemberNameTagInput({ value, placeholder, onChange }: { value: string[]; placeholder: string; onChange(value: string[]): void }) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (raw = draft) => {
    const additions = parseMemberNames(raw);
    if (additions.length) onChange([...new Set([...value, ...additions])]);
    setDraft('');
  };
  const remove = (name: string) => onChange(value.filter(item => item !== name));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') { event.preventDefault(); commit(); }
    else if (event.key === 'Backspace' && !draft && value.length) remove(value[value.length - 1]!);
  };
  return <div role="group" aria-label="成员真实姓名" onClick={() => inputRef.current?.focus()} className="mt-2 flex min-h-11 cursor-text flex-wrap items-center gap-x-2 gap-y-2 rounded-md border border-strong bg-muted p-2 transition-[border-color,box-shadow,background-color] duration-fast ease-out focus-within:border-action focus-within:bg-surface focus-within:ring-2 focus-within:ring-focus-ring">
    {value.map(item => <span key={item} title={item} className="flex h-7 max-w-full items-center rounded-sm border border-default bg-surface pl-2.5 pr-1 text-caption font-medium text-secondary shadow-card">
      <span className="min-w-0 truncate">{item}</span>
      <button type="button" aria-label={`移除 ${item}`} onPointerDown={event => event.preventDefault()} onClick={() => remove(item)} className="ml-1.5 grid h-5 w-5 shrink-0 place-items-center rounded-sm text-subtle transition-colors duration-fast ease-out hover:bg-muted hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"><X size={11}/></button>
    </span>)}
    <input ref={inputRef} aria-label="输入成员真实姓名" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} onBlur={() => commit()} onPaste={event => { const text = event.clipboardData.getData('text'); if (/[\n,，]/.test(text)) { event.preventDefault(); commit(`${draft}\n${text}`); } }} placeholder={value.length ? '继续添加成员…' : placeholder} className="h-7 min-w-36 flex-[1_0_9rem] border-0 bg-transparent px-1 text-caption text-primary outline-none placeholder:text-subtle"/>
  </div>;
}
