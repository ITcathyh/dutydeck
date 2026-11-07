/** 输入法组字中的按键。Safari 确认候选词那次 keydown 的 isComposing 已经是 false，只剩 keyCode 229 能认出来。 */
export const isImeComposing = (event: { nativeEvent: { isComposing?: boolean }; keyCode?: number }) =>
  Boolean(event.nativeEvent.isComposing) || event.keyCode === 229;
