// 放在 MarkdownContent 之外：工作台首屏要用复制，但不该因此带上 Markdown 渲染与代码高亮。
// 优先 Clipboard API；API 缺失或 writeText 被拒（权限/非安全上下文）时退回 textarea + execCommand。
// 两路都不引入 window.prompt 之类的原生弹窗——Dutydeck 使用自定义 portal 弹窗。
export async function copyToClipboard(code: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(code);
      return true;
    } catch {
      // 落到 legacy 路径重试
    }
  }
  return legacyCopy(code);
}

function legacyCopy(code: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  // 临时 textarea 会抢走选区与焦点，先记下以便 finally 还原。
  const activeElement = document.activeElement;
  const selection = document.getSelection();
  const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
  const textarea = document.createElement('textarea');
  textarea.value = code;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    // execCommand 可能返回 false，也可能直接抛错，两种都算复制失败。
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (savedRange && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
    if (activeElement instanceof HTMLElement || activeElement instanceof SVGElement) activeElement.focus();
  }
}
