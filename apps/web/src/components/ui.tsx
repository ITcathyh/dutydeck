export const stateLabels: Record<string, string> = {
  created: '已创建', starting: '启动中', idle: '就绪', thinking: '思考中', running_tool: '正在调用工具', waiting_for_permission: '等待授权', interrupting: '正在取消', interrupted: '已取消', completed: '已完成', failed: '失败', stopped: '已停止'
};
export const stateTone: Record<string, string> = { starting: 'bg-amber-500', thinking: 'bg-amber-500', running_tool: 'bg-blue-500', waiting_for_permission: 'bg-orange-500', failed: 'bg-red-500', stopped: 'bg-zinc-400', interrupted: 'bg-zinc-500', completed: 'bg-emerald-500', idle: 'bg-emerald-500' };
export const busyStates = new Set(['starting', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting']);
export const parseMemberNames = (value: string) => [...new Set(value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean))];

export function DockmuxIcon({ className = '' }: { className?: string }) {
  return <img src="/dockmux.svg" alt="" aria-hidden="true" className={className}/>;
}

export function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="grid h-8 w-8 place-items-center rounded-lg text-zinc-500 transition-[color,background-color,transform] duration-200 hover:bg-zinc-100 hover:text-zinc-900 active:scale-[.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 disabled:pointer-events-none disabled:opacity-30">{children}</button>;
}
