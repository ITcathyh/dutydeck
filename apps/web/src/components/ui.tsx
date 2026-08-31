export const stateLabels: Record<string, string> = {
  created: '已创建', starting: '启动中', idle: '就绪', thinking: '思考中', running_tool: '正在调用工具', waiting_for_permission: '等待授权', interrupting: '正在取消', interrupted: '已取消', completed: '已完成', failed: '失败', stopped: '已停止'
};
export const stateTone: Record<string, string> = { starting: 'bg-[var(--status-warning-solid)]', thinking: 'bg-[var(--status-warning-solid)]', running_tool: 'bg-[var(--status-info-solid)]', waiting_for_permission: 'bg-[var(--status-attention-solid)]', failed: 'bg-[var(--status-danger-solid)]', stopped: 'bg-[var(--status-neutral-solid)]', interrupted: 'bg-[var(--status-neutral-solid)]', completed: 'bg-[var(--status-success-solid)]', idle: 'bg-[var(--status-success-solid)]' };
export const busyStates = new Set(['starting', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting']);
export const parseMemberNames = (value: string) => [...new Set(value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean))];

export function DockmuxIcon({ className = '' }: { className?: string }) {
  return <img src="/dockmux.svg" alt="" aria-hidden="true" className={className}/>;
}

export function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--text-muted)] transition-[color,background-color,transform] duration-200 hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] active:scale-[.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-default)] disabled:pointer-events-none disabled:opacity-30">{children}</button>;
}
