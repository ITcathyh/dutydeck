import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { Agent } from '../api';

export type CompactOption = { value: string; label: string; meta?: string };
export function CompactSelect({ options, value, placeholder, disabledText, disabled = false, onChange }: { options: CompactOption[]; value: string; placeholder: string; disabledText: string; disabled?: boolean; onChange(value: string): void }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = `compact-select-${useId()}`;
  const selected = options.find(option => option.value === value);
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  const openList = (index = selectedIndex) => {
    setActiveIndex(Math.min(Math.max(index, 0), Math.max(options.length - 1, 0)));
    setOpen(true);
  };
  const closeList = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus());
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeList();
  };
  const move = (index: number) => {
    const next = (index + options.length) % options.length;
    setActiveIndex(next);
    optionRefs.current[next]?.focus();
  };
  const triggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); closeList(); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      if (!open) { event.preventDefault(); openList(); }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : selectedIndex;
      openList(index);
    }
  };
  const optionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeList(); return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(index); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      move(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1));
    }
  };
  return <div ref={root} className="relative mt-1.5">
    <button ref={trigger} type="button" disabled={disabled || !options.length} aria-haspopup="listbox" aria-controls={listboxId} aria-expanded={open} onKeyDown={triggerKeyDown} onClick={() => { if (open) closeList(false); else openList(); }} className="flex h-9 w-full items-center rounded-md border border-zinc-300 bg-white px-2.5 text-left text-[13px] outline-none hover:border-zinc-400 focus:border-zinc-500 focus:ring-1 focus:ring-zinc-200 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400">
      <span className="min-w-0 flex-1 truncate">{selected?.label ?? (options.length ? placeholder : disabledText)}</span>
      {selected?.meta && <span className="ml-3 max-w-[48%] truncate font-mono text-[10px] text-zinc-400">{selected.meta}</span>}
      <ChevronDown size={13} className={`ml-2 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}/>
    </button>
    {open && <div id={listboxId} role="listbox" aria-label={placeholder} className="ui-popover absolute inset-x-0 top-[calc(100%+4px)] z-40 max-h-44 overscroll-contain overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-[0_12px_32px_rgba(24,24,27,.12)] [transform:translateZ(0)]">
      {options.map((option, index) => <button ref={node => { optionRefs.current[index] = node; }} key={option.value} type="button" role="option" tabIndex={index === activeIndex ? 0 : -1} aria-selected={option.value === value} onFocus={() => setActiveIndex(index)} onMouseMove={() => setActiveIndex(index)} onKeyDown={event => optionKeyDown(event, index)} onClick={() => choose(index)} className={`flex min-h-8 w-full items-center rounded-md px-2 text-left text-[12px] text-zinc-700 transition-colors ${index === activeIndex ? 'bg-zinc-100' : 'hover:bg-zinc-100'}`}>
        <span className="w-5 shrink-0 text-zinc-800">{option.value === value && <Check size={12}/>}</span><span className="min-w-0 flex-1 truncate">{option.label}</span>{option.meta && <span className="ml-3 max-w-[55%] truncate font-mono text-[10px] text-zinc-400">{option.meta}</span>}
      </button>)}
    </div>}
  </div>;
}

export function AgentSelect({ agents, value, disabled, onChange }: { agents: Agent[]; value: string; disabled?: boolean; onChange(value: string): void }) {
  return <CompactSelect options={agents.map(agent => ({ value: agent.id, label: agent.name, meta: agent.version }))} value={value} placeholder="选择 Agent" disabledText="未扫描到可用 Agent" disabled={disabled} onChange={onChange}/>;
}
