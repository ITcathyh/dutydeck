import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Field, Input, Select, Textarea } from './Field';

// Field 收敛 14 处手写输入框，这些用例盯的是三个「静默失效」的无障碍缺陷：
// label 与控件没绑上、hint 与 error 同时存在时 aria-describedby 只挂了 error、
// 有错误却不置 aria-invalid。这三条都不会报错，只会让读屏用户丢信息。

describe('Field label 绑定', () => {
  it('label 的 htmlFor 指向控件 id，点标签能聚焦控件', async () => {
    const user = userEvent.setup();
    render(<Field label="工作目录"><Input/></Field>);
    const input = screen.getByLabelText('工作目录') as HTMLInputElement;
    const label = document.querySelector('label')!;
    expect(label.getAttribute('for')).toBe(input.id);
    expect(input.id).toBeTruthy();
    await user.click(label);
    expect(document.activeElement).toBe(input);
  });

  it('显式传入的 htmlFor 优先，控件跟着用同一个 id', () => {
    render(<Field label="工作目录" htmlFor="cwd-input"><Input/></Field>);
    const input = screen.getByLabelText('工作目录');
    expect(input.id).toBe('cwd-input');
    expect(document.querySelector('label')!.getAttribute('for')).toBe('cwd-input');
  });

  it('多个 Field 各自生成互不冲突的 id', () => {
    render(<>
      <Field label="工作目录"><Input/></Field>
      <Field label="分支名"><Input/></Field>
    </>);
    const first = screen.getByLabelText('工作目录');
    const second = screen.getByLabelText('分支名');
    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();
    expect(first.id).not.toBe(second.id);
  });
});

describe('Field 提示与错误的无障碍关联', () => {
  it('hint 与 error 同时存在时，aria-describedby 两个都要列', () => {
    render(<Field label="工作目录" hint="填绝对路径" error="目录不存在"><Input/></Field>);
    const input = screen.getByLabelText('工作目录');
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(described.length).toBe(2);
    const hintId = screen.getByText('填绝对路径').id;
    const errorId = screen.getByText('目录不存在').id;
    expect(described).toContain(hintId);
    expect(described).toContain(errorId);
    // 顺序也有意义：先读填写要求，再读错误原因。
    expect(described).toEqual([hintId, errorId]);
  });

  it('只有 hint 时 aria-describedby 只指向 hint', () => {
    render(<Field label="工作目录" hint="填绝对路径"><Input/></Field>);
    const input = screen.getByLabelText('工作目录');
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByText('填绝对路径').id);
  });

  it('既无 hint 也无 error 时不留空的 aria-describedby', () => {
    render(<Field label="工作目录"><Input/></Field>);
    expect(screen.getByLabelText('工作目录').hasAttribute('aria-describedby')).toBe(false);
  });

  it('错误文本带 role=alert，出现即播报', () => {
    render(<Field label="工作目录" error="目录不存在"><Input/></Field>);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('目录不存在');
    expect(alert.className).toContain('text-danger');
  });

  it('aria-invalid 只在有错误时出现', () => {
    const clean = render(<Field label="工作目录" hint="填绝对路径"><Input/></Field>);
    expect(screen.getByLabelText('工作目录').hasAttribute('aria-invalid')).toBe(false);
    clean.unmount();
    render(<Field label="工作目录" error="目录不存在"><Input/></Field>);
    expect(screen.getByLabelText('工作目录').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('Field 必填', () => {
  it('required 渲染星号标记并把 required 传给控件', () => {
    render(<Field label="工作目录" required><Input/></Field>);
    // 星号是纯装饰：读屏靠 required 属性播报，无障碍名里不该混进「*」。
    const input = screen.getByRole('textbox', { name: '工作目录' }) as HTMLInputElement;
    expect(input.required).toBe(true);
    const marker = document.querySelector('label span')!;
    expect(marker.textContent).toBe('*');
    expect(marker.getAttribute('aria-hidden')).toBe('true');
  });

  it('不必填时既没有星号也不置 required', () => {
    render(<Field label="工作目录"><Input/></Field>);
    expect((screen.getByLabelText('工作目录') as HTMLInputElement).required).toBe(false);
    expect(document.querySelector('label span')).toBeNull();
  });
});

describe('Field 控件消费 context', () => {
  it('Input 从 context 拿到 id 与 aria-describedby', () => {
    render(<Field label="工作目录" hint="填绝对路径" error="目录不存在"><Input/></Field>);
    const input = screen.getByLabelText('工作目录');
    expect(input.tagName).toBe('INPUT');
    expect(input.id).toBeTruthy();
    expect(input.getAttribute('aria-describedby')!.split(' ').length).toBe(2);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('Textarea 从 context 拿到 id 与 aria-describedby', () => {
    render(<Field label="任务描述" hint="支持 Markdown" error="不能为空"><Textarea/></Field>);
    const textarea = screen.getByLabelText('任务描述');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.id).toBeTruthy();
    expect(textarea.getAttribute('aria-describedby')!.split(' ').length).toBe(2);
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
  });

  it('Select 从 context 拿到 id 与 aria-describedby', () => {
    render(<Field label="模型" hint="按会话生效" error="该模型不可用"><Select><option value="a">A</option></Select></Field>);
    const select = screen.getByLabelText('模型');
    expect(select.tagName).toBe('SELECT');
    expect(select.id).toBeTruthy();
    expect(select.getAttribute('aria-describedby')!.split(' ').length).toBe(2);
    expect(select.getAttribute('aria-invalid')).toBe('true');
  });

  it('控件被额外容器包一层时，aria 仍然落在控件上而不是容器上', () => {
    render(<Field label="工作目录" hint="填绝对路径"><div className="flex gap-2"><Input/></div></Field>);
    const input = screen.getByLabelText('工作目录');
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByText('填绝对路径').id);
    expect(document.querySelector('div.flex.gap-2')!.hasAttribute('aria-describedby')).toBe(false);
  });

  it('调用方显式传的 id / aria-describedby 压过 context', () => {
    render(<Field label="工作目录" hint="填绝对路径" htmlFor="outer"><Input id="inner" aria-describedby="custom-note"/></Field>);
    const input = document.getElementById('inner')!;
    expect(input.getAttribute('aria-describedby')).toBe('custom-note');
  });

  it('脱离 Field 单用时不炸，也不生造 aria 属性', () => {
    render(<Input aria-label="裸输入框"/>);
    const input = screen.getByLabelText('裸输入框');
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });
});

describe('Field 尺寸', () => {
  it('Input 与 Select 统一 40px 高（h-10）', () => {
    render(<>
      <Field label="工作目录"><Input/></Field>
      <Field label="模型"><Select><option value="a">A</option></Select></Field>
    </>);
    expect(screen.getByLabelText('工作目录').className).toContain('h-10');
    expect(screen.getByLabelText('模型').className).toContain('h-10');
  });

  it('Textarea 用最小高度而不是固定 40px', () => {
    render(<Field label="任务描述"><Textarea/></Field>);
    const textarea = screen.getByLabelText('任务描述');
    expect(textarea.className).toContain('min-h-20');
    expect(textarea.className).not.toContain('h-10');
  });

  it('调用方的 className 追加在内置样式之后，不覆盖掉基础类', () => {
    render(<Field label="工作目录"><Input className="font-mono"/></Field>);
    const input = screen.getByLabelText('工作目录');
    expect(input.className).toContain('font-mono');
    expect(input.className).toContain('h-10');
  });
});
