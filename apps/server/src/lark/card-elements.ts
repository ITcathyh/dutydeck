// 多处卡片共用的元素构造。不 import 任何模块：commands.ts 等纯模块也要能引用。

type CardElement = Record<string, any>;

export const markdownElement = (elementId: string, content: string): CardElement => ({
  tag: 'markdown', element_id: elementId, content
});

export const escapeCardInline = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** 标题行右侧带展开箭头的折叠面板；版式未传的项取最常用的值。 */
export const collapsiblePanel = (elementId: string, title: CardElement, elements: CardElement[], layout: {
  expanded?: boolean; verticalSpacing?: string; padding?: string; margin?: string; iconSize?: string;
} = {}): CardElement => ({
  tag: 'collapsible_panel', element_id: elementId, expanded: layout.expanded ?? false,
  direction: 'vertical', vertical_spacing: layout.verticalSpacing ?? '4px', padding: layout.padding ?? '4px 0px 0px 0px', margin: layout.margin ?? '0px',
  header: {
    title,
    vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: layout.iconSize ?? '14px 14px' },
    icon_position: 'right', icon_expanded_angle: -180
  },
  elements
});
