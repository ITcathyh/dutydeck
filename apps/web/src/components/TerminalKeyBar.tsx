import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Keyboard, MousePointer2, PanelLeftClose, PanelRightClose } from 'lucide-react';

// 移动端 PTY 终端的屏幕快捷键条。手机键盘没有 Esc / Ctrl / Tab / 方向键，
// 少了这一条终端在手机上只能看不能用。
//
// 这里是纯展示组件：只负责渲染按键、折叠状态与停靠边，按下时把控制序列交给 onKey 回调。
// TerminalView 拿到序列后走它已有的 {type:'input',data} 帧发给 PTY。
// 这样拆是为了能在 jsdom 里测——xterm.js 在 jsdom 跑不起来，整块塞进 TerminalView 就没法测。

export type TerminalKeyBarSide = 'left' | 'right';

export type TerminalKeyBarProps = {
  // 把控制序列写进 PTY。TerminalView 传的实现里会顺带把焦点还给终端。
  onKey(data: string): void;
  // 切换「选择模式」：开启后手指拖动走 xterm 原生选中以便复制，关闭时拖动滚动回看历史。
  // 不传则不渲染这个开关（例如桌面强制展示时用不到）。
  onSelectModeChange?: (selecting: boolean) => void;
  selectMode?: boolean;
};

// 每颗键要写给 PTY 的字节。序列见 apps/web/TERMINAL_API.md 引用的 xterm 输入约定。
type KeyDef = { id: string; label: string; data: string; aria: string; wide?: boolean };

const primaryKeys: KeyDef[] = [
  { id: 'esc', label: 'Esc', data: '\x1b', aria: '发送 Esc 退出当前模式' },
  { id: 'tab', label: 'Tab', data: '\t', aria: '发送 Tab 补全' },
  { id: 'ctrl-c', label: '^C', data: '\x03', aria: '发送 Ctrl-C 中断当前命令' },
  { id: 'ctrl-d', label: '^D', data: '\x04', aria: '发送 Ctrl-D 结束输入' },
  { id: 'up', label: '↑', data: '\x1b[A', aria: '方向键上，翻出上一条历史命令' },
  { id: 'down', label: '↓', data: '\x1b[B', aria: '方向键下，翻到下一条历史命令' },
  { id: 'left', label: '←', data: '\x1b[D', aria: '方向键左，光标左移' },
  { id: 'right', label: '→', data: '\x1b[C', aria: '方向键右，光标右移' },
  { id: 'enter', label: '↵', data: '\r', aria: '发送回车执行' }
];

const secondaryKeys: KeyDef[] = [
  { id: 'ctrl-z', label: '^Z', data: '\x1a', aria: '发送 Ctrl-Z 把当前命令转到后台' },
  { id: 'ctrl-l', label: '^L', data: '\x0c', aria: '发送 Ctrl-L 清屏' },
  { id: 'ctrl-r', label: '^R', data: '\x12', aria: '发送 Ctrl-R 反向搜索历史命令' },
  { id: 'home', label: 'Home', data: '\x1b[H', aria: '发送 Home 跳到行首', wide: true },
  { id: 'end', label: 'End', data: '\x1b[F', aria: '发送 End 跳到行尾', wide: true },
  { id: 'pgup', label: 'PgUp', data: '\x1b[5~', aria: '发送 PgUp 向上翻页', wide: true },
  { id: 'pgdn', label: 'PgDn', data: '\x1b[6~', aria: '发送 PgDn 向下翻页', wide: true }
];

const COLLAPSED_KEY = 'dockmux.terminal_key_bar.collapsed.v1';
const SIDE_KEY = 'dockmux.terminal_key_bar.side.v1';

// localStorage 在 Safari 隐私模式下读写都会抛异常，每次访问都要兜住，读不到就用默认值。
function readStored(key: string): string | undefined {
  try { return window.localStorage.getItem(key) ?? undefined; }
  catch { return undefined; }
}

function writeStored(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); }
  catch { /* 隐私模式或配额写满：位置记不住不影响本次使用 */ }
}

// 44px 触控目标（min-h-11 min-w-11）是高频移动操作的下限，比设计基线 40px 再放宽一档：
// Ctrl-C 打错一次要么杀错进程要么白等，代价比多占几像素高得多。
// 圆角按契约 §3 的「半径 ≈ 高度/3.5」取档：键帽 44px 落在 31–47px 档，用 rounded-md（10px）。
// 键帽刻意保持原生 <button> 而不换 Button 原语：它们是等宽 mono 的键帽，且靠 onPointerDown /
// onMouseDown 的 preventDefault 保软键盘，Button / IconButton 的 props 形状盖不住这两件事。
const keyClass = 'flex min-h-11 min-w-11 items-center justify-center rounded-md border border-default bg-surface px-2 font-mono text-body font-semibold text-primary transition active:bg-action-soft active:text-action';
const chromeClass = 'flex min-h-11 min-w-11 items-center justify-center rounded-md text-secondary transition active:bg-hover';

export function TerminalKeyBar({ onKey, onSelectModeChange, selectMode = false }: TerminalKeyBarProps) {
  const [expanded, setExpanded] = useState(() => readStored(COLLAPSED_KEY) !== '1');
  const [side, setSide] = useState<TerminalKeyBarSide>(() => (readStored(SIDE_KEY) === 'left' ? 'left' : 'right'));
  const [more, setMore] = useState(false);

  useEffect(() => { writeStored(COLLAPSED_KEY, expanded ? '0' : '1'); }, [expanded]);
  useEffect(() => { writeStored(SIDE_KEY, side); }, [side]);

  // 按键不能抢走 xterm textarea 的焦点：焦点一丢，手机软键盘就收起来，
  // 用户点完一次快捷键还得重新点终端才能继续打字。preventDefault 拦在 pointerdown/mousedown
  // 上（点击焦点转移就发生在这一步），真正发送仍走 onClick，键盘 Enter/Space 才不会被吞掉。
  const holdFocus = useCallback((event: { preventDefault(): void }) => { event.preventDefault(); }, []);

  const dockClass = side === 'left' ? 'left-0 pl-[max(0.5rem,env(safe-area-inset-left))]' : 'right-0 pr-[max(0.5rem,env(safe-area-inset-right))]';

  // min-w-14（56px）落在 4px 网格上，取代原来的 3.25rem（52px，不在网格上）。
  // 这是宽度下限不是上限：Home/End/PgUp/PgDn 在 14px mono 下实测约 50px，塞得进去不会被挤压。
  const renderKey = (key: KeyDef) => <button key={key.id} type="button" aria-label={key.aria} onPointerDown={holdFocus} onMouseDown={holdFocus} onClick={() => onKey(key.data)} className={`${keyClass} ${key.wide ? 'min-w-14' : ''}`}>{key.label}</button>;

  return <div className={`pointer-events-none absolute bottom-0 z-sticky flex justify-end pb-[max(0.5rem,env(safe-area-inset-bottom))] ${dockClass}`}>
    <div role="toolbar" aria-label="终端快捷键" aria-orientation="horizontal" className="pointer-events-auto flex max-w-[min(20rem,calc(100vw-1.5rem))] flex-col gap-1.5 rounded-lg border border-default bg-muted p-1.5 shadow-panel">
      <div className="flex items-center gap-1">
        <button type="button" aria-expanded={expanded} aria-label={expanded ? '收起终端快捷键条' : '展开终端快捷键条'} onPointerDown={holdFocus} onMouseDown={holdFocus} onClick={() => setExpanded(value => !value)} className={chromeClass}>
          {expanded ? <ChevronDown size={18}/> : <Keyboard size={18}/>}
        </button>
        {expanded && <>
          <button type="button" aria-label={side === 'right' ? '把快捷键条移到左侧' : '把快捷键条移到右侧'} onPointerDown={holdFocus} onMouseDown={holdFocus} onClick={() => setSide(value => (value === 'right' ? 'left' : 'right'))} className={chromeClass}>
            {side === 'right' ? <PanelLeftClose size={18}/> : <PanelRightClose size={18}/>}
          </button>
          {onSelectModeChange && <button type="button" aria-label={selectMode ? '退出选择模式，恢复拖动滚动' : '进入选择模式，拖动可选中文字复制'} aria-pressed={selectMode} onPointerDown={holdFocus} onMouseDown={holdFocus} onClick={() => onSelectModeChange(!selectMode)} className={`${chromeClass} ${selectMode ? 'bg-action-soft text-action' : ''}`}>
            <MousePointer2 size={18}/>
          </button>}
          <button type="button" aria-expanded={more} aria-label={more ? '收起更多按键' : '展开更多按键，含 Ctrl-Z、清屏与翻页'} onPointerDown={holdFocus} onMouseDown={holdFocus} onClick={() => setMore(value => !value)} className={`${chromeClass} font-mono text-body`}>⋯</button>
        </>}
      </div>
      {expanded && <div className="flex flex-wrap justify-end gap-1.5">{primaryKeys.map(renderKey)}</div>}
      {expanded && more && <div className="flex flex-wrap justify-end gap-1.5 border-t border-subtle pt-1.5">{secondaryKeys.map(renderKey)}</div>}
    </div>
  </div>;
}
