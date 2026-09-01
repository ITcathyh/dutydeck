import { createContext, useContext, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

export type FieldProps = {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
};

type FieldContextValue = {
  controlId: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
};

const FieldContext = createContext<FieldContextValue | undefined>(undefined);

/**
 * 表单控件从这里取到 Field 已经算好的 id / aria-describedby / aria-invalid。
 *
 * 用 context 而不是 cloneElement：cloneElement 只能穿透**直接**子元素，
 * 一旦调用方在控件外面包一层 flex 容器（14 处手写输入框里已有好几处这么写），
 * aria 属性就会静默落在那个 div 上——读屏读不到提示，而且没有任何报错。
 * CompactSelect 这类业务控件也可以直接消费这个 hook 接上无障碍关联。
 */
export const useFieldControl = () => useContext(FieldContext);

/*
  收敛 14 处手写输入框。

  Field 负责三件调用点最常漏的事：
  1. label 与控件用 id 绑定（点标签能聚焦控件）；
  2. hint 与 error 同时存在时，aria-describedby 要**两个都列**，
     只挂 error 会让读屏用户丢掉填写要求；
  3. error 存在时置 aria-invalid，并让错误文本带 role=alert 即时播报。
*/
export function Field({ label, hint, error, required = false, htmlFor, children }: FieldProps) {
  const generated = useId();
  const controlId = htmlFor ?? `field-${generated}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return <FieldContext.Provider value={{ controlId, describedBy, invalid: Boolean(error), required }}>
    <div className="flex flex-col gap-1.5">
      <label htmlFor={controlId} className="text-caption font-medium text-secondary">
        {label}
        {required && <span aria-hidden="true" className="ml-0.5 text-danger">*</span>}
      </label>
      {children}
      {hint && <p id={hintId} className="text-caption text-subtle">{hint}</p>}
      {error && <p id={errorId} role="alert" className="text-caption text-danger">{error}</p>}
    </div>
  </FieldContext.Provider>;
}

/* 输入类控件是契约 §5 白名单第 2 类：可点击边界允许画线。统一 40px 高（契约 §9）。 */
const controlClass = 'w-full rounded-md border border-default bg-surface px-3 text-body text-primary transition-colors duration-fast ease-out placeholder:text-subtle hover:border-strong focus:border-action focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-subtle';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const field = useFieldControl();
  return <input
    {...rest}
    id={rest.id ?? field?.controlId}
    aria-describedby={rest['aria-describedby'] ?? field?.describedBy}
    aria-invalid={rest['aria-invalid'] ?? (field?.invalid || undefined)}
    required={rest.required ?? field?.required}
    className={cn(controlClass, 'h-10', className)}
  />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useFieldControl();
  return <textarea
    {...rest}
    id={rest.id ?? field?.controlId}
    aria-describedby={rest['aria-describedby'] ?? field?.describedBy}
    aria-invalid={rest['aria-invalid'] ?? (field?.invalid || undefined)}
    required={rest.required ?? field?.required}
    className={cn(controlClass, 'min-h-20 py-2.5', className)}
  />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  const field = useFieldControl();
  return <select
    {...rest}
    id={rest.id ?? field?.controlId}
    aria-describedby={rest['aria-describedby'] ?? field?.describedBy}
    aria-invalid={rest['aria-invalid'] ?? (field?.invalid || undefined)}
    required={rest.required ?? field?.required}
    className={cn(controlClass, 'h-10', className)}
  >{children}</select>;
}
