import { Check } from 'lucide-react';
import { Button } from './Button';
import { cn } from './cn';

export type SaveBarProps = {
  dirty: boolean;
  saving: boolean;
  /** 有值时在状态区显示红色错误并禁用保存。 */
  error?: string;
  /** 额外的保存禁用条件（与 !dirty 并列）。 */
  saveDisabled?: boolean;
  savedText: string;
  /** 状态文字后的桌面端提示。 */
  hint?: string;
  saveLabel: string;
  /** 追加到外层容器的 className。 */
  className?: string;
  onReset(): void;
  onSave(): void;
};

/** 设置页底部的「状态 + 放弃修改 + 保存」条。 */
export function SaveBar({ dirty, saving, error, saveDisabled, savedText, hint, saveLabel, className, onReset, onSave }: SaveBarProps) {
  return <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
    <div className="text-caption text-subtle">
      {error ? (
        <span className="font-medium text-danger">{error}</span>
      ) : dirty ? (
        <span className="font-medium text-warning">● 有未保存的修改</span>
      ) : (
        <span>{savedText}</span>
      )}
      {hint && <span className="ml-2 hidden sm:inline text-meta text-subtle">
        {hint}
      </span>}
    </div>
    <div className="flex items-center gap-2">
      <Button variant="secondary" disabled={!dirty || saving} onClick={onReset}>
        放弃修改
      </Button>
      <Button variant="primary" disabled={!dirty || Boolean(error) || saveDisabled} loading={saving} onClick={onSave}>
        <Check size={14} className="mr-1.5" />
        {saveLabel}
      </Button>
    </div>
  </div>;
}
