import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemberNameTagInput } from './MemberNameTagInput';

// 飞书成员白名单输入框：分隔符（含中文逗号）、去重、Backspace 删除、失焦提交、
// 粘贴多行——每一条都直接决定谁能操作 Bot，误吞/误加都是权限事故。

const setup = (value: string[] = []) => {
  const onChange = vi.fn();
  const view = render(<MemberNameTagInput value={value} placeholder="输入姓名" onChange={onChange}/>);
  return { onChange, input: screen.getByLabelText('输入成员真实姓名'), view };
};

describe('MemberNameTagInput 提交分隔符', () => {
  it('Enter 提交当前草稿', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();
    await user.type(input, '张三{Enter}');
    expect(onChange).toHaveBeenCalledWith(['张三']);
  });

  it('英文逗号提交', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();
    await user.type(input, '张三,');
    expect(onChange).toHaveBeenCalledWith(['张三']);
  });

  it('中文逗号提交（中文输入法下最常见的分隔键）', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();
    await user.type(input, '张三，');
    expect(onChange).toHaveBeenCalledWith(['张三']);
  });

  it('失焦时提交未回车的草稿，避免用户输入被静默丢弃', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();
    await user.type(input, '李四');
    await user.tab();
    expect(onChange).toHaveBeenCalledWith(['李四']);
  });

  it('提交后清空输入框', async () => {
    const user = userEvent.setup();
    const { input } = setup();
    await user.type(input, '张三{Enter}');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('空白草稿不产生回调（不会加入空标签）', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();
    await user.type(input, '   {Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('MemberNameTagInput 去重与追加', () => {
  it('追加到已有列表尾部', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup(['张三']);
    await user.type(input, '李四{Enter}');
    expect(onChange).toHaveBeenCalledWith(['张三', '李四']);
  });

  it('重复姓名不会加两遍', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup(['张三']);
    await user.type(input, '张三{Enter}');
    expect(onChange).toHaveBeenCalledWith(['张三']);
  });

  it('一次输入多个（逗号分隔）拆成多个标签并去重', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();
    // 逐字符输入时逗号会即时提交，这里用 paste 模拟一次性粘贴多值
    await user.click(input);
    await user.paste('张三,李四,张三');
    expect(onChange).toHaveBeenCalledWith(['张三', '李四']);
  });

  it('粘贴多行文本拆成多个标签', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();
    await user.click(input);
    await user.paste('张三\n李四\n王五');
    expect(onChange).toHaveBeenCalledWith(['张三', '李四', '王五']);
  });

  it('粘贴不含分隔符的单值不立即提交，留给用户继续编辑', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();
    await user.click(input);
    await user.paste('张三');
    expect(onChange).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('张三');
  });
});

describe('MemberNameTagInput 删除', () => {
  it('渲染已有标签及其移除按钮', () => {
    setup(['张三', '李四']);
    expect(screen.getByText('张三')).toBeTruthy();
    expect(screen.getByRole('button', { name: '移除 李四' })).toBeTruthy();
  });

  it('点击移除按钮删掉对应标签，保留其余', async () => {
    const user = userEvent.setup();
    const { onChange } = setup(['张三', '李四']);
    await user.click(screen.getByRole('button', { name: '移除 张三' }));
    expect(onChange).toHaveBeenCalledWith(['李四']);
  });

  it('草稿为空时 Backspace 删除最后一个标签', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup(['张三', '李四']);
    await user.click(input);
    await user.keyboard('{Backspace}');
    expect(onChange).toHaveBeenCalledWith(['张三']);
  });

  it('草稿非空时 Backspace 只删字符，不误删标签', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup(['张三']);
    await user.type(input, '李');
    await user.keyboard('{Backspace}');
    expect(onChange).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('无标签时 Backspace 不回调', async () => {
    const user = userEvent.setup();
    const { onChange, input } = setup();
    await user.click(input);
    await user.keyboard('{Backspace}');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('MemberNameTagInput placeholder', () => {
  it('空列表时用传入 placeholder；已有标签时改为「继续添加成员…」', () => {
    const { view } = setup();
    expect(screen.getByLabelText('输入成员真实姓名').getAttribute('placeholder')).toBe('输入姓名');
    view.rerender(<MemberNameTagInput value={['张三']} placeholder="输入姓名" onChange={() => {}}/>);
    expect(screen.getByLabelText('输入成员真实姓名').getAttribute('placeholder')).toBe('继续添加成员…');
  });
});
