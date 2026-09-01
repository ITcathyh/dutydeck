import { useEffect, useRef } from 'react';

/*
  当前启用的 Escape 监听栈（后进先出）。

  一次 Escape 只应该关掉**最上面**那一层。没有这个栈的话，Dialog 里开一个
  Popover（NewSessionModal 的 Agent 选择器就是这个形状）时按 Escape，
  两个 document 监听都会触发，弹层和选择面板一起消失——用户想收起下拉，
  结果整个表单没了，填了一半的内容全丢。

  用 preventDefault / stopPropagation 解决不了：两个监听都挂在 document 上，
  同一阶段的监听器不会因为 stopPropagation 而互相取消（那需要
  stopImmediatePropagation，而它依赖注册顺序，恰恰是不可靠的那个东西）。
  所以在 hook 内部显式维护「谁在最上层」。
*/
const stack: Array<{ current: () => void }> = [];

/**
 * Escape 关闭浮层，全站唯一实现。
 *
 * 合并 7 处独立监听（ControlCenter / LarkConfig / NewSession / ConfirmDialog /
 * ShortcutHelp / CommandPalette / App 移动导航）。这 7 处的行为原本并不一致，
 * 差异全部收进 `enabled`：
 *   - ConfirmDialog、LarkConfigModal、NewSessionModal、ControlCenterModal 在提交中
 *     不允许 Escape 关闭（会把一个进行中的写操作丢在半路），传 `open && !busy`；
 *   - ShortcutHelpSheet 无条件关闭，传 `open`。
 * 判断留在调用点，因为「什么算忙」是各浮层自己的业务；这里只负责监听与摘除。
 *
 * 嵌套时只有最后启用的那一层会响应（见上面 stack 的注释）。
 *
 * handler 存进 ref：调用点几乎都传内联箭头函数，把它放进依赖数组会让监听器每次
 * 渲染都重新挂载，keydown 在挂载间隙丢事件。
 */
export function useEscapeKey(enabled: boolean, handler: () => void): void {
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const entry = latest;
    stack.push(entry);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // 只有栈顶响应。同一次按键里其他层的监听照样会跑到这里，但都会在这一行返回。
      if (stack.at(-1) !== entry) return;
      event.preventDefault();
      entry.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = stack.lastIndexOf(entry);
      if (index !== -1) stack.splice(index, 1);
    };
  }, [enabled]);
}
