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
 * 只改 CommonMark 没用上的 `**`：解析结果里仍是字面量的星号，以及配错的粗体（配不上的闭合被当成开头，
 * 与后面的 `**` 配成了对，可能跨行），且后者要两端都能在各自行内配成新粗体才拆。
 * 正常的粗体（含合法的跨行粗体）、代码、链接因此逐字节保持原样。
 * 全文解析两次：一次找候选，一次复核整批改写；复核要求除新增的同行粗体和拆掉的错配粗体外，
 * 其余语法节点的类型与位置完全不变，否则原样返回。
 */

interface MdNode {
  type: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** 位置有语法含义的标点，不挪：转义、强调、代码、链接、飞书标签、删除线、表格竖线、实体。 */
const UNMOVABLE = new Set(['\\', '*', '_', '`', '[', ']', '<', '>', '|', '~', '&']);
/**
 * 超出任一上限的正文不修复，保证渲染耗时有上界。卡片整体上限也是 16KB（larkCardSnapshotLimits），更长的正文本来就要截断；
 * 解析器耗时随同一段落里的粗体数平方增长，`**` 数再设一道上限，上限内最坏一次修复约百毫秒。
 */
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_STRONG_RUNS = 2000;
const LINK_NODES = new Set(['link', 'image', 'linkReference', 'imageReference', 'definition']);

type CharClass = 'space' | 'punct' | 'other';

function classify(char: string | undefined): CharClass {
  // 行首行尾按空白处理，与 CommonMark 一致。
  if (char === undefined || /\s/u.test(char)) return 'space';
  return /[\p{P}\p{S}]/u.test(char) ? 'punct' : 'other';
}

const movable = (char: string | undefined) => char !== undefined && classify(char) === 'punct' && !UNMOVABLE.has(char);

/** 偏移处前后各一个码点。 */
const charBefore = (text: string, offset: number) => Array.from(text.slice(Math.max(0, offset - 2), offset)).at(-1);
const charAt = (text: string, offset: number) => text.codePointAt(offset) === undefined ? undefined : String.fromCodePoint(text.codePointAt(offset)!);

interface Candidate {
  /** 开头 `**` 在全文中的偏移。 */
  start: number;
  /** 闭合 `**` 在全文中的偏移。 */
  closeStart: number;
  /** 改写后开头、闭合 `**` 的偏移。 */
  newStart: number;
  newCloseStart: number;
  before: string;
  after: string;
}

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

/** 同一行相邻两个 `**` 之间的改写；只看这一行的字符，`**` 是否可改由解析结果决定。 */
function pairCandidate(line: string, lineStart: number, open: number, close: number): Candidate | undefined {
  const inner = line.slice(open + 2, close);
  if (!inner || /[*&<>[\]|~]/.test(inner)) return undefined;
  // 紧贴开头的 ASCII 串若是裸 URL，飞书可能把它连同后面的星号一起识别为链接，其字节不是正文。
  // 汉字和全角标点会截断 URL，所以只看开头前面连续的 ASCII 可见字符。
  const urlish = /[\x21-\x7e]*$/.exec(line.slice(0, open))?.[0] ?? '';
  if (/:\/\/|www\./i.test(urlish + line.slice(open, close))) return undefined;

  const innerChars = Array.from(inner);
  const prev = charBefore(line, open);
  const next = charAt(line, close + 2);
  let lead = 0;
  // 开头配不上：外侧是字母或汉字，内侧第一个是标点。
  if (classify(prev) === 'other' && classify(innerChars[0]) === 'punct') {
    while (lead < innerChars.length && movable(innerChars[lead])) lead++;
  }
  let trail = 0;
  // 闭合配不上：内侧最后一个是标点，外侧是字母或汉字。
  if (classify(next) === 'other' && classify(innerChars.at(-1)) === 'punct') {
    while (trail < innerChars.length - lead && movable(innerChars[innerChars.length - 1 - trail])) trail++;
  }
  if (!lead && !trail) return undefined;
  const core = innerChars.slice(lead, innerChars.length - trail);
  // 不留空粗体，也不让空白贴着分隔符。
  if (!core.length || classify(core[0]) === 'space' || classify(core.at(-1)) === 'space') return undefined;
  // 保住转义：`\:` 不能丢掉被转义的字符。
  if (core.at(-1) === '\\') return undefined;
  const leadText = innerChars.slice(0, lead).join('');
  const trailText = innerChars.slice(innerChars.length - trail).join('');
  return {
    start: lineStart + open,
    closeStart: lineStart + close,
    newStart: lineStart + open + leadText.length,
    newCloseStart: lineStart + close - trailText.length,
    before: line.slice(open, close + 2),
    after: leadText + '**' + core.join('') + '**' + trailText
  };
}

interface Parsed {
  /** 链接之外的 text 节点范围，按文档顺序。 */
  texts: Array<{ start: number; end: number }>;
  /** 链接之外的粗体。 */
  strongs: Array<{ start: number; end: number }>;
  /** 除 text 外所有节点的“类型:起:止”，用于复核。 */
  signature: string[];
}

function parse(text: string): Parsed {
  const parsed: Parsed = { texts: [], strongs: [], signature: [] };
  const walk = (node: MdNode, inLink: boolean): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (LINK_NODES.has(node.type)) inLink = true;
    if (start !== undefined && end !== undefined) {
      if (node.type === 'text') { if (!inLink) parsed.texts.push({ start, end }); }
      else parsed.signature.push(`${node.type}:${start}:${end}`);
      if (node.type === 'strong' && !inLink) parsed.strongs.push({ start, end });
    }
    for (const child of node.children ?? []) walk(child, inLink);
  };
  walk(fromMarkdown(text) as MdNode, false);
  return parsed;
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
  if (!input.includes('**') || Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) return input;
  // 先只看字符：同一行相邻两个 `**` 能否通过挪标点配上。绝大多数正文到这里就没有候选，不必解析。
  const possible: Candidate[] = [];
  let lineStart = 0;
  let runCount = 0;
  for (const line of input.split('\n')) {
    if (line.includes('**')) {
      const runs = strongRuns(line);
      runCount += runs.length;
      if (runCount > MAX_STRONG_RUNS) return input;
      for (let k = 0; k + 1 < runs.length; k++) {
        const candidate = pairCandidate(line, lineStart, runs[k]!, runs[k + 1]!);
        if (candidate) possible.push(candidate);
      }
    }
    lineStart += line.length + 1;
  }
  if (!possible.length) return input;

  // 解析结果决定哪些 `**` 可改：仍是字面量的，和疑似错配的粗体的两端。错配粗体的开头外侧是标点、内侧是文字，
  // 也就是一个配不上的闭合被当成了开头，例如 `**甲：**乙**丙：**丁` 里的 `：**乙**`，或上一行末尾配到下一行的粗体。
  const before = parse(input);
  const free = new Set<number>();
  const strongAt = new Map<number, { start: number; end: number }>();
  for (const strong of before.strongs) {
    if (!movable(charBefore(input, strong.start)) || classify(charAt(input, strong.start + 2)) !== 'other') continue;
    free.add(strong.start); free.add(strong.end - 2);
    strongAt.set(strong.start, strong); strongAt.set(strong.end - 2, strong);
  }
  let textIndex = 0;
  const isLiteral = (offset: number) => {
    while (textIndex < before.texts.length && before.texts[textIndex]!.end < offset + 2) textIndex++;
    const text = before.texts[textIndex];
    return text !== undefined && text.start <= offset;
  };
  for (const candidate of possible) {
    for (const offset of [candidate.start, candidate.closeStart]) if (!free.has(offset) && isLiteral(offset)) free.add(offset);
  }

  // 相邻两对共用一个分隔符时，只留靠前、不重叠的那对。
  const pairAt = new Map<number, Candidate>();
  let last: Candidate | undefined;
  for (const candidate of possible) {
    if (!free.has(candidate.start) || !free.has(candidate.closeStart)) continue;
    if (last && candidate.start <= last.closeStart) continue;
    pairAt.set(candidate.start, candidate); pairAt.set(candidate.closeStart, candidate);
    last = candidate;
  }
  // 疑似错配的粗体只有两端都能在各自行内配成新粗体时才拆；否则按合法粗体保留（如 `结论：**很重要**`），
  // 用到它一端的改写作废，作废的改写若用到另一个疑似粗体的一端，那个粗体也保留，依次传递。
  const dissolved = new Set<string>();
  const pending = [...new Set(strongAt.values())];
  while (pending.length) {
    const strong = pending.pop()!;
    const ends = [strong.start, strong.end - 2];
    if (ends.every(offset => pairAt.has(offset))) { dissolved.add(`strong:${strong.start}:${strong.end}`); continue; }
    for (const offset of ends) {
      const candidate = pairAt.get(offset);
      if (!candidate) continue;
      pairAt.delete(candidate.start); pairAt.delete(candidate.closeStart);
      for (const other of [candidate.start, candidate.closeStart]) {
        const affected = strongAt.get(other);
        if (affected && affected !== strong) {
          dissolved.delete(`strong:${affected.start}:${affected.end}`);
          pending.push(affected);
        }
      }
    }
  }
  const chosen = [...new Set(pairAt.values())].sort((a, b) => a.start - b.start);
  if (!chosen.length) return input;

  // 复核：每对改写恰好多出一个粗体，用到的错配粗体消失，其余节点的类型与位置一个不差。
  const expected = before.signature.filter(entry => !dissolved.has(entry))
    .concat(chosen.map(candidate => `strong:${candidate.newStart}:${candidate.newCloseStart + 2}`))
    .sort();
  const output = apply(input, chosen);
  const actual = parse(output).signature.sort();
  return expected.length === actual.length && expected.every((entry, index) => entry === actual[index]) ? output : input;
}
