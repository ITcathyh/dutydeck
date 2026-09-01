import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { Agent } from '../api';
import { useEscapeKey } from '../useEscapeKey';
import { useFieldControl } from './primitives';

export type CompactOption = { value: string; label: string; meta?: string };
export function CompactSelect({ options, value, placeholder, disabledText, disabled = false, onChange }: { options: CompactOption[]; value: string; placeholder: string; disabledText: string; disabled?: boolean; onChange(value: string): void }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = `compact-select-${useId()}`;
  // 套在 <Field> 里时接上 hint / error 的 aria-describedby。只取 describedBy：
  // controlId 会顶掉触发器自己的 id 语义，而 Field 的 label 也不该改写触发器的可访问名
  // （名字来自当前选中项，读屏用户靠它知道选了什么）。
  const field = useFieldControl();
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

  /*
    Escape 走**两套**机制，缺一不可。想删掉其中一个之前请先读完这段。

    1. 下面 triggerKeyDown / optionKeyDown 里的 `stopPropagation()`
       —— 挡的是 **React 合成事件的冒泡**，让外层容器的 onKeyDown 收不到这次按键
       （`CompactSelect.dom.test.tsx` 有断言守着）。它顺带也挡住了 document 上的
       原生监听：React 把监听挂在 root container / portal container 上，两者都是
       document 的后代，所以合成事件先跑，stopPropagation 之后事件到不了 document。
       Phase 1 实测：Dialog portal 到 body 之后这条路径**依然成立**（React 会给
       portal container 也挂上监听），契约 §8.1 担心的失效并没有发生。

    2. `useEscapeKey(open, …)`
       —— 补的是第 1 条覆盖不到的洞：**焦点不在本组件里、但 listbox 还开着**。
       比如用户点开下拉后又去点了弹层里别处的输入框。这时没有任何合成事件经过
       CompactSelect，Escape 直接打到 document，只有 Dialog 那层的 useEscapeKey 响应
       —— 整张填了一半的表单就没了。实测复现过，这正是契约 §8.1 要防的事故。
       接上 useEscapeKey 之后，listbox 打开的瞬间本组件被压进 LIFO 栈顶
       （Dialog 的条目在弹层挂载时就已入栈，下拉永远后于它启用），Escape 只触发这一层，
       Dialog 那层会在 `stack.at(-1) !== entry` 处返回。

    两条路径互斥，不会重复关闭：走第 1 条时事件根本到不了 document。即便真的都跑到，
    closeList 也是幂等的（setOpen(false) + 聚焦触发器）。
  */
  useEscapeKey(open, () => closeList());

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
  // mt-1.5 保留：调用点普遍是「<span>标签</span><CompactSelect/>」的裸结构（LarkConfigModal
  // 仍是这个形状），间距由本组件自带。拿掉会让那些调用点的标签和控件贴在一起。
  return <div ref={root} className="relative mt-1.5">
    <button ref={trigger} type="button" disabled={disabled || !options.length} aria-haspopup="listbox" aria-controls={listboxId} aria-expanded={open} aria-describedby={field?.describedBy} onKeyDown={triggerKeyDown} onClick={() => { if (open) closeList(false); else openList(); }} className="flex h-10 w-full items-center rounded-md border border-default bg-surface px-3 text-left text-body text-primary transition-colors duration-fast ease-out hover:border-strong focus:border-action focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-subtle">
      <span className="min-w-0 flex-1 truncate">{selected?.label ?? (options.length ? placeholder : disabledText)}</span>
      {selected?.meta && <span className="ml-3 max-w-[48%] truncate font-mono text-meta text-subtle">{selected.meta}</span>}
      <ChevronDown size={14} className={`ml-2 shrink-0 text-subtle transition-transform duration-fast ease-out ${open ? 'rotate-180' : ''}`}/>
    </button>
    {/*
      刻意**不用** <Popover> 原语。Popover 在 Escape 时自己做「聚焦锚点 + onClose」，
      而 CompactSelect 有一整套 roving tabindex：activeIndex 状态、optionRefs、
      方向键/Home/End 移动焦点、以及关闭时按 restoreFocus 决定还不还焦点。换过去要
      重写大半键盘逻辑，风险远大于「少一份浮层壳」的收益。
      面板就地渲染，层级取 z-drawer(800)：它是 Dialog 面板的后代，而 Dialog 自己
      在 z-dialog(900) 上已经建立了 stacking context，子级的 800 只在这个上下文内部
      排序，不会被 Dialog 盖住。
    */}
    {open && <div id={listboxId} role="listbox" aria-label={placeholder} className="ui-popover absolute inset-x-0 top-[calc(100%+4px)] z-drawer max-h-60 overscroll-contain overflow-y-auto rounded-lg border border-default bg-surface p-1 shadow-panel [transform:translateZ(0)]">
      {options.map((option, index) => <button ref={node => { optionRefs.current[index] = node; }} key={option.value} type="button" role="option" tabIndex={index === activeIndex ? 0 : -1} aria-selected={option.value === value} onFocus={() => setActiveIndex(index)} onMouseMove={() => setActiveIndex(index)} onKeyDown={event => optionKeyDown(event, index)} onClick={() => choose(index)} className={`flex min-h-10 w-full items-center rounded-md px-2 text-left text-caption text-secondary transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${index === activeIndex ? 'bg-muted' : 'hover:bg-muted'}`}>
        <span className="w-5 shrink-0 text-primary">{option.value === value && <Check size={13}/>}</span><span className="min-w-0 flex-1 truncate">{option.label}</span>{option.meta && <span className="ml-3 max-w-[55%] truncate font-mono text-meta text-subtle">{option.meta}</span>}
      </button>)}
    </div>}
  </div>;
}

export function AgentSelect({ agents, value, disabled, onChange }: { agents: Agent[]; value: string; disabled?: boolean; onChange(value: string): void }) {
  return <CompactSelect options={agents.map(agent => ({ value: agent.id, label: agent.name, meta: agent.version }))} value={value} placeholder="选择 Agent" disabledText="未扫描到可用 Agent" disabled={disabled} onChange={onChange}/>;
}
