// 思路与复核规则适配自 Botmux（MIT，Copyright (c) 2026 botmux contributors）commit ab4299095 的
// src/im/lark/card-strong-punctuation.ts；这里改用已有依赖 mdast-util-from-markdown 实现，许可证全文见 THIRD_PARTY_NOTICES.md。
import { fromMarkdown } from 'mdast-util-from-markdown';

/**
 * 卡片正文里 `**粗体**` 的显示层修复。
 *
 * CommonMark 的配对规则下，闭合 `**` 前是标点、后是字母或汉字时，它只能开不能关，
 * 于是 `**结论：**正文` 整段配不上，飞书直接把两组星号原样显示。开头对称：`说明**（重要）**`。
 * 修复方式是把紧贴分隔符内侧的标点挪到外侧：`**结论**：正文`、`说明（**重要**）`。
 * 文本长度和其余字节都不变。
 *
 * 每处改写都要过整篇文档的 mdast 复核：必须恰好多出一个同行粗体，星号字面量相应减少，
 * 链接、斜体数量不变。代码、转义、链接文字、嵌套和本来就能渲染的粗体因此逐字节保持原样。
 */

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { line: number; offset?: number }; end: { line: number; offset?: number } };
}

/** 位置有语法含义的标点，不挪：转义、强调、代码、链接、飞书标签、删除线、表格竖线、实体。 */
const UNMOVABLE = new Set(['\\', '*', '_', '`', '[', ']', '<', '>', '|', '~', '&']);
/** 回退路径每次探测验证的改写数。个别候选配不上时，代价按坏候选数增长，而不是按全文长度。 */
const FALLBACK_CHUNK = 32;
/** 内容原样保留的节点：代码、行内 HTML、链接与图片（含引用式）、链接定义。 */
const LITERAL_NODES = new Set(['code', 'inlineCode', 'html', 'link', 'image', 'linkReference', 'imageReference', 'definition']);
const LINK_NODES = new Set(['link', 'image', 'linkReference', 'imageReference']);

type CharClass = 'space' | 'punct' | 'other';

function classify(char: string | undefined): CharClass {
  // 行首行尾按空白处理，与 CommonMark 一致。
  if (char === undefined || /\s/u.test(char)) return 'space';
  return /[\p{P}\p{S}]/u.test(char) ? 'punct' : 'other';
}

const movable = (char: string) => classify(char) === 'punct' && !UNMOVABLE.has(char);

interface Candidate {
  /** 开头 `**` 在全文中的偏移。 */
  start: number;
  /** 闭合 `**` 在全文中的偏移。 */
  closeStart: number;
  before: string;
  after: string;
}

interface Metrics {
  /** 链接之外、起止在同一行的粗体。 */
  strong: number;
  /** 跨行粗体：本函数的输入里它们都是错配（上一行配不上的闭合 `**` 与下一行配不上的开头 `**` 互相配成了对）。 */
  strongAcrossLines: number;
  strongInLink: number;
  links: number;
  em: number;
  literalStars: number;
}

function metrics(text: string): Metrics {
  const result: Metrics = { strong: 0, strongAcrossLines: 0, strongInLink: 0, links: 0, em: 0, literalStars: 0 };
  const walk = (node: MdNode, inLink: boolean): void => {
    if (LINK_NODES.has(node.type)) { result.links++; inLink = true; }
    else if (node.type === 'strong') {
      if (inLink) result.strongInLink++;
      else if (node.position && node.position.start.line !== node.position.end.line) result.strongAcrossLines++;
      else result.strong++;
    } else if (node.type === 'emphasis') result.em++;
    else if (node.type === 'text') result.literalStars += (node.value ?? '').split('*').length - 1;
    for (const child of node.children ?? []) walk(child, inLink);
  };
  walk(fromMarkdown(text) as MdNode, false);
  return result;
}

/** `pairs` 处改写各自要多出一个同行粗体；也允许顺带拆掉已有的跨行错配（其 4 个星号变回字面量），但不能新增跨行粗体，也不能动链接和斜体。 */
function improvedBy(before: Metrics, after: Metrics, pairs: number): boolean {
  const dissolved = before.strongAcrossLines - after.strongAcrossLines;
  return dissolved >= 0
    && after.strong === before.strong + pairs
    && after.strongInLink === before.strongInLink
    && after.links === before.links
    && after.em === before.em
    && after.literalStars === before.literalStars - 4 * pairs + 4 * dissolved;
}

interface Range { start: number; end: number }

function literalRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const walk = (node: MdNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (LITERAL_NODES.has(node.type) && start !== undefined && end !== undefined) ranges.push({ start, end });
    else for (const child of node.children ?? []) walk(child);
  };
  walk(fromMarkdown(text) as MdNode);
  return ranges;
}

const insideLiteral = (ranges: readonly Range[], start: number, end: number) =>
  ranges.some(range => start < range.end && end > range.start);

/** 一行内恰为两个星号的分隔符位置，跳过反斜杠转义。 */
function strongRuns(line: string): number[] {
  const runs: number[] = [];
  for (let index = 0; index < line.length;) {
    if (line[index] === '\\') { index += 2; continue; }
    if (line[index] !== '*') { index++; continue; }
    let end = index;
    while (line[end] === '*') end++;
    if (end - index === 2) runs.push(index);
    index = end;
  }
  return runs;
}

/** 只看单行文本，不判断代码与链接；那部分在拿到候选之后由 literalRanges 过滤。 */
function lineCandidates(line: string, lineStart: number): Candidate[] {
  const candidates: Candidate[] = [];
  const runs = strongRuns(line);
  for (let k = 0; k + 1 < runs.length; k++) {
    const open = runs[k]!;
    const close = runs[k + 1]!;
    const inner = line.slice(open + 2, close);
    if (!inner || /[*&<>[\]|~]/.test(inner)) continue;
    // 紧贴开头的 ASCII 串若是裸 URL，飞书可能把它连同后面的星号一起识别为链接，其字节不是正文。
    // 汉字和全角标点会截断 URL，所以只看开头前面连续的 ASCII 可见字符。
    const urlish = /[\x21-\x7e]*$/.exec(line.slice(0, open))?.[0] ?? '';
    if (/:\/\/|www\./i.test(urlish + line.slice(open, close))) continue;

    const innerChars = Array.from(inner);
    const prev = Array.from(line.slice(0, open)).at(-1);
    const next = Array.from(line.slice(close + 2))[0];
    let lead = 0;
    // 开头配不上：外侧是字母或汉字，内侧第一个是标点。
    if (classify(prev) === 'other' && classify(innerChars[0]) === 'punct') {
      while (lead < innerChars.length && movable(innerChars[lead]!)) lead++;
    }
    let trail = 0;
    // 闭合配不上：内侧最后一个是标点，外侧是字母或汉字。
    if (classify(next) === 'other' && classify(innerChars.at(-1)) === 'punct') {
      while (trail < innerChars.length - lead && movable(innerChars[innerChars.length - 1 - trail]!)) trail++;
    }
    if (!lead && !trail) continue;
    const core = innerChars.slice(lead, innerChars.length - trail);
    // 不留空粗体，也不让空白贴着分隔符。
    if (!core.length || classify(core[0]) === 'space' || classify(core.at(-1)) === 'space') continue;
    // 保住转义：`\:` 不能丢掉被转义的字符。
    if (core.at(-1) === '\\') continue;
    candidates.push({
      start: lineStart + open,
      closeStart: lineStart + close,
      before: line.slice(open, close + 2),
      after: innerChars.slice(0, lead).join('') + '**' + core.join('') + '**' + innerChars.slice(innerChars.length - trail).join('')
    });
  }
  return candidates;
}

function apply(text: string, candidates: readonly Candidate[]): string {
  let output = '';
  let cursor = 0;
  for (const candidate of candidates) {
    output += text.slice(cursor, candidate.start) + candidate.after;
    cursor = candidate.start + candidate.before.length;
  }
  return output + text.slice(cursor);
}

export function repairCardStrongPunctuation(input: string): string {
  if (!input.includes('**')) return input;
  const raw: Candidate[] = [];
  let lineStart = 0;
  for (const line of input.split('\n')) {
    if (line.includes('**')) {
      for (const candidate of lineCandidates(line, lineStart)) {
        // 相邻两对共用一个分隔符时，只留靠前、不重叠的那对。
        const last = raw.at(-1);
        if (!last || candidate.start >= last.start + last.before.length) raw.push(candidate);
      }
    }
    lineStart += line.length + 1;
  }
  // 绝大多数正文没有可修的粗体，不必解析整篇文档。
  if (!raw.length) return input;

  const ranges = literalRanges(input);
  const candidates = raw.filter(candidate =>
    !insideLiteral(ranges, candidate.start, candidate.start + 2)
    && !insideLiteral(ranges, candidate.closeStart, candidate.closeStart + 2));
  if (!candidates.length) return input;

  const baseline = metrics(input);
  const batched = apply(input, candidates);
  if (improvedBy(baseline, metrics(batched), candidates.length)) return batched;

  // 有改写没按预期配对（跨行嵌套、残缺的 `**` 等）：分块验证，坏块再逐条试。
  let output = input;
  let current = baseline;
  for (let index = 0; index < candidates.length; index += FALLBACK_CHUNK) {
    const chunk = candidates.slice(index, index + FALLBACK_CHUNK)
      .filter(candidate => output.slice(candidate.start, candidate.start + candidate.before.length) === candidate.before);
    if (!chunk.length) continue;
    const next = apply(output, chunk);
    const nextMetrics = metrics(next);
    if (improvedBy(current, nextMetrics, chunk.length)) { output = next; current = nextMetrics; continue; }
    for (const candidate of chunk) {
      if (output.slice(candidate.start, candidate.start + candidate.before.length) !== candidate.before) continue;
      const single = apply(output, [candidate]);
      const singleMetrics = metrics(single);
      if (!improvedBy(current, singleMetrics, 1)) continue;
      output = single;
      current = singleMetrics;
    }
  }
  return output;
}
