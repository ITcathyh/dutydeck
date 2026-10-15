import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';

const MAX_FILE_BYTES = 1_000_000;
const ITEM_CHARS = 4_000;
const TITLE_WEIGHT = 3;
const BODY_HITS_CAP = 5;

const asStrings = value => (Array.isArray(value) ? value : []).filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean);

const countOccurrences = (haystack, needle) => {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) count += 1;
  return count;
};

const abortedError = error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR';

/** `## 标题` 行返回标题文字：`##` 后要跟空白，去掉首尾空白和末尾的闭合 `#`。手工判断，避免正则在长空白行上回溯。 */
function headingOf(line) {
  if (!line.startsWith('##') || (line[2] !== ' ' && line[2] !== '\t')) return undefined;
  const title = line.slice(2).trim();
  let end = title.length;
  while (end > 0 && title[end - 1] === '#') end -= 1;
  const closed = end < title.length && end > 0 && (title[end - 1] === ' ' || title[end - 1] === '\t');
  return (closed ? title.slice(0, end).trimEnd() : title) || undefined;
}

/** 按二级标题切段；围栏代码块里的 `## ` 不算标题。第一个二级标题之前的内容（若有）是 index 0 的前言段。 */
export function splitSections(markdown, fallbackTitle) {
  const sections = [];
  let current = { heading: undefined, lines: [] };
  let fence;
  const flush = () => {
    const text = current.lines.join('\n').trim();
    if (text || current.heading) sections.push({ heading: current.heading ?? fallbackTitle, text });
  };
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    }
    const heading = fence ? undefined : headingOf(line);
    if (heading) { flush(); current = { heading, lines: [line] }; }
    else current.lines.push(line);
  }
  flush();
  return sections.filter(section => section.text);
}

/** 命中的关键字在标题里按 3 倍计，在正文里每个关键字最多计 5 次。 */
export function scoreSection(section, keywords) {
  const heading = section.heading.toLowerCase();
  const body = section.text.toLowerCase();
  let score = 0;
  for (const keyword of keywords) score += countOccurrences(heading, keyword) * TITLE_WEIGHT + Math.min(countOccurrences(body, keyword), BODY_HITS_CAP);
  return score;
}

/** 校验 docs 里的一项：只允许 docs_dir 内的相对路径。返回词法检查后的相对路径，或拒绝原因。 */
function checkRelativePath(doc) {
  if (doc.includes('\0')) return { reason: '路径无效' };
  if (isAbsolute(doc) || /^[A-Za-z]:/.test(doc) || doc.startsWith('\\')) return { reason: '只允许 docs_dir 内的相对路径' };
  if (doc.split(/[\\/]/).includes('..')) return { reason: '路径不能包含 ..' };
  if (!/\.(md|markdown)$/i.test(doc)) return { reason: '不是 Markdown 文件（.md）' };
  return { path: doc };
}

async function readDoc(realRoot, doc, signal) {
  const checked = checkRelativePath(doc);
  if (!checked.path) return { reason: checked.reason };
  let real;
  try { real = await realpath(join(realRoot, checked.path)); }
  catch { return { reason: '文件不存在或无法读取' }; }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { reason: '路径指向 docs_dir 之外' };
  try {
    const info = await stat(real);
    if (!info.isFile()) return { reason: '不是文件' };
    if (info.size > MAX_FILE_BYTES) return { reason: `文件超过 ${MAX_FILE_BYTES / 1_000_000} MB` };
    return { real, content: await readFile(real, { encoding: 'utf8', signal }) };
  } catch (error) {
    if (abortedError(error)) throw error;
    return { reason: '文件不存在或无法读取' };
  }
}

/** 总长（标题加正文）不超过 maxChars。被 maxChars 卡住的那一段截断后结束；只被单项上限截断的，后面的段继续取。 */
function fitBudget(ranked, maxChars) {
  const items = [];
  let remaining = maxChars;
  for (const section of ranked) {
    const room = remaining - section.title.length;
    if (room <= 0) continue;
    const limit = Math.min(room, ITEM_CHARS);
    let text = section.text;
    if (text.length > limit) {
      text = text.slice(0, Math.max(0, limit - 1));
      if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
      text += '…';
    }
    items.push({ id: section.id, title: section.title, text });
    remaining -= section.title.length + text.length;
    if (text.length < section.text.length && limit === room) break;
  }
  return items;
}

/**
 * 场景 provider `runbook`：读群参数 `docs` 列出的、docs_dir 内的 Markdown，按二级标题切段，
 * 用消息里命中的 `topics` 关键字打分，取分高的段落放进 maxChars。读不到或被拒的文件写进 missing。
 */
export function createRunbookProvider({ docsDir } = {}) {
  return {
    id: 'runbook',
    async context({ message, params, maxChars, signal }) {
      const missing = [];
      const docs = [...new Set(asStrings(params.docs))];
      if (!docs.length) return { items: [], missing: ['群参数 docs 没有填 runbook 文件'] };
      if (!docsDir) return { items: [], missing: ['插件配置 docs_dir 未设置'] };
      let realRoot;
      try { realRoot = await realpath(docsDir); }
      catch { return { items: [], missing: ['docs_dir 不存在或无法读取'] }; }

      const text = (message?.text ?? '').toLowerCase();
      const keywords = [...new Set(asStrings(params.topics).map(topic => topic.toLowerCase()))].filter(topic => text.includes(topic));
      const candidates = [];
      const seen = new Set();
      let aborted = signal?.aborted ?? false;
      for (const [fileIndex, doc] of docs.entries()) {
        if (aborted || signal?.aborted) { aborted = true; missing.push(`${doc}：未读取（已中止）`); continue; }
        let result;
        try { result = await readDoc(realRoot, doc, signal); }
        catch (error) {
          if (!abortedError(error)) throw error;
          aborted = true;
          missing.push(`${doc}：未读取（已中止）`);
          continue;
        }
        if (result.reason) { missing.push(`${doc}：${result.reason}`); continue; }
        if (seen.has(result.real)) continue;
        seen.add(result.real);
        const fileTitle = doc.replace(/\\/g, '/');
        splitSections(result.content, fileTitle.replace(/^.*\//, '').replace(/\.(md|markdown)$/i, '')).forEach((section, index) => {
          candidates.push({ id: `${fileTitle}#${index}`, title: `${fileTitle} · ${section.heading}`, text: section.text, fileIndex, index, score: scoreSection(section, keywords) });
        });
      }
      const ranked = candidates.filter(section => section.score > 0).sort((a, b) => b.score - a.score || a.fileIndex - b.fileIndex || a.index - b.index);
      return { items: fitBudget(ranked, maxChars), missing };
    }
  };
}
