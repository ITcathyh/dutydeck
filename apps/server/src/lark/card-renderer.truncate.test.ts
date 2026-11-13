import { describe, expect, it } from 'vitest';
import { renderLarkVerificationElement } from './card-renderer.js';

const suffix = '\n…（内容过长，已截断）';
const limit = 120;

const renderedCommand = (command: string) => {
  const content = renderLarkVerificationElement({ command })!.content;
  return content.slice(content.indexOf('`') + 1, content.lastIndexOf('`'));
};

describe('卡片长文本按 Unicode 码点截断', () => {
  it.each([limit - 1, limit])('BMP 文本在上限内不截断（%s 个码点）', length => {
    expect(renderedCommand('界'.repeat(length))).toBe('界'.repeat(length));
  });

  it('BMP 文本超过上限时保留原上限与后缀', () => {
    const rendered = renderedCommand('界'.repeat(limit + 1));
    expect(rendered).toBe(`${'界'.repeat(limit)}${suffix}`);
    expect(Array.from(rendered)).toHaveLength(limit + Array.from(suffix).length);
  });

  it.each([limit - 1, limit])('emoji 在上限内不截断（%s 个码点）', length => {
    expect(renderedCommand('😀'.repeat(length))).toBe('😀'.repeat(length));
  });

  it('emoji 跨过上限时不留下半个代理对，后缀长度不变', () => {
    const prefix = 'a'.repeat(limit - 1);
    const rendered = renderedCommand(`${prefix}😀尾`);
    expect(rendered).toBe(`${prefix}😀${suffix}`);
    expect(rendered.isWellFormed()).toBe(true);
    expect(Array.from(rendered)).toHaveLength(limit + Array.from(suffix).length);
  });

  it('组合字符按码点计数，其后的 emoji 仍完整保留', () => {
    const prefix = 'a'.repeat(limit - 3);
    const rendered = renderedCommand(`${prefix}é😀尾`);
    expect(rendered).toBe(`${prefix}é😀${suffix}`);
    expect(rendered.isWellFormed()).toBe(true);
  });

  it('组合字簇可在码点边界拆分，但不制造非法代理对', () => {
    const prefix = 'a'.repeat(limit - 1);
    const rendered = renderedCommand(`${prefix}é😀`);
    expect(rendered).toBe(`${prefix}e${suffix}`);
    expect(rendered.isWellFormed()).toBe(true);
  });
});
