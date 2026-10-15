import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateScenarioPack } from '@dutydeck/shared';
import register from '../index.mjs';
import { createRunbookProvider, scoreSection, splitSections } from '../provider.mjs';

const hooks = vi.hoisted(() => ({ beforeRead: undefined as undefined | (() => void), afterRead: undefined as undefined | (() => void) }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (async (...args: Parameters<typeof actual.readFile>) => { hooks.beforeRead?.(); const result = await actual.readFile(...args); hooks.afterRead?.(); return result; }) as typeof actual.readFile };
});

const directories: string[] = [];
async function workspace() {
  const base = await mkdtemp(join(tmpdir(), 'dutydeck-team-faq-'));
  directories.push(base);
  const docs = join(base, 'docs');
  await mkdir(docs);
  const outside = join(base, 'outside');
  await mkdir(outside);
  return { base, docs, outside };
}
const write = async (path: string, content: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };

const message = (text: string) => ({
  messageId: 'm1', chatId: 'c1', senderKind: 'human' as const, messageType: 'text', text, mentionsSelf: false, mentionsOther: false
});
async function run(docsDir: string | undefined, input: { text: string; topics?: string[]; docs?: unknown; maxChars?: number; signal?: AbortSignal }) {
  const provider = createRunbookProvider({ docsDir });
  return provider.context({
    scope: { appId: 'app', chatId: 'c1' }, message: message(input.text),
    params: { topics: input.topics ?? [], docs: input.docs ?? [] },
    maxChars: input.maxChars ?? 6000, signal: input.signal ?? new AbortController().signal
  });
}

const orders = [
  '# 订单服务 runbook', '简介：订单服务由 alpha 团队维护。', '',
  '## 5xx 排查', '先看订单服务的错误率，再看下游。', '订单服务 5xx 多半是下游超时。', '',
  '## 发布流程', '发布前确认变更单。', '',
  '## 容量', '订单服务容量按 QPS 估算。'
].join('\n');

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('team-faq: section splitting', () => {
  it('splits on level-2 headings, keeps the preamble, ignores ### and fenced code', () => {
    const sections = splitSections([
      '# 标题', '前言一行', '## A', 'a 正文', '### A.1', '子节内容', '```sh', '## 不是标题', '```', '## B C ##', 'b 正文'
    ].join('\n'), 'file');
    expect(sections.map(section => section.heading)).toEqual(['file', 'A', 'B C']);
    expect(sections[1]!.text).toContain('### A.1');
    expect(sections[1]!.text).toContain('## 不是标题');
    expect(sections[0]!.text).toContain('前言一行');
  });

  it('parses a heading line with a very long whitespace run in linear time', () => {
    const started = Date.now();
    const sections = splitSections(`##${' '.repeat(30_000)}x${' '.repeat(30_000)}y\n正文\n## 尾部${' '.repeat(30_000)}\n## ${' '.repeat(30_000)}`, 'f');
    expect(Date.now() - started).toBeLessThan(100);
    expect(sections.map(section => section.heading.trim().slice(0, 1))).toContain('x');
    expect(sections.map(section => section.heading)).toContain('尾部');
  });

  it('drops the empty preamble of a file that starts with a heading', () => {
    expect(splitSections('## A\nx\n## B\ny', 'f').map(section => section.heading)).toEqual(['A', 'B']);
  });

  it('keeps a trailing # that belongs to the heading text', () => {
    expect(splitSections('## 学习 C#\nx', 'f')[0]!.heading).toBe('学习 C#');
  });
});

describe('team-faq: scoring and ranking', () => {
  it('weights heading hits over body hits, caps body hits, ignores case', () => {
    expect(scoreSection({ heading: 'Order 排查', text: 'x' }, ['order'])).toBe(3);
    expect(scoreSection({ heading: 'x', text: 'order Order ORDER' }, ['order'])).toBe(3);
    expect(scoreSection({ heading: 'x', text: 'order '.repeat(20) }, ['order'])).toBe(5);
    expect(scoreSection({ heading: 'x', text: 'nothing' }, ['order'])).toBe(0);
  });

  it('returns the best sections first, only those that scored, with stable ids and titles', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'orders.md'), orders);
    const first = await run(docs, { text: '订单服务 5xx 怎么排查', topics: ['订单服务', '5xx', '支付'], docs: ['orders.md'] });
    expect(first.missing).toEqual([]);
    expect(first.items.map(item => item.id)).toEqual(['orders.md#1', 'orders.md#0', 'orders.md#3']);
    expect(first.items.map(item => item.title)).toEqual(['orders.md · 5xx 排查', 'orders.md · orders', 'orders.md · 容量']);
    expect(first.items[0]!.text).toContain('下游超时');
    const second = await run(docs, { text: '订单服务 5xx 怎么排查', topics: ['订单服务', '5xx', '支付'], docs: ['orders.md'] });
    expect(second).toEqual(first);
  });

  it('only scores keywords that the message actually hits', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'a.md'), '## 订单\n订单 订单\n');
    await write(join(docs, 'b.md'), '## 支付\n支付 支付\n');
    const result = await run(docs, { text: '支付挂了', topics: ['订单', '支付'], docs: ['a.md', 'b.md'] });
    expect(result.items.map(item => item.id)).toEqual(['b.md#0']);
  });

  it('breaks ties by docs order then section order', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'a.md'), '## 一\nkw\n## 二\nkw\n');
    await write(join(docs, 'b.md'), '## 三\nkw\n');
    const result = await run(docs, { text: 'kw', topics: ['kw'], docs: ['b.md', 'a.md'] });
    expect(result.items.map(item => item.id)).toEqual(['b.md#0', 'a.md#0', 'a.md#1']);
  });

  it('reads files when docs_dir itself is a symlink', async () => {
    const { base, docs } = await workspace();
    await write(join(docs, 'a.md'), '## 一\nkw\n');
    await symlink(docs, join(base, 'docs-link'));
    const result = await run(join(base, 'docs-link'), { text: 'kw', topics: ['kw'], docs: ['a.md'] });
    expect(result.missing).toEqual([]);
    expect(result.items.map(item => item.id)).toEqual(['a.md#0']);
  });

  it('returns one item set for different spellings of the same file, keeping the first spelling', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'sub/ok.md'), '## 一\nkw\n');
    await symlink(join(docs, 'sub'), join(docs, 'alias'));
    const result = await run(docs, { text: 'kw', topics: ['kw'], docs: ['sub/ok.md', './sub/ok.md', 'sub//ok.md', 'alias/ok.md'] });
    expect(result.missing).toEqual([]);
    expect(result.items.map(item => item.id)).toEqual(['sub/ok.md#0']);
  });

  it('supports nested relative paths and reads a symlink that stays inside docs_dir', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'team/oncall.md'), '## 值班\nkw\n');
    await symlink(join(docs, 'team'), join(docs, 'alias'));
    const result = await run(docs, { text: 'kw', topics: ['kw'], docs: ['alias/oncall.md'] });
    expect(result.missing).toEqual([]);
    expect(result.items.map(item => item.id)).toEqual(['alias/oncall.md#0']);
  });
});

describe('team-faq: maxChars', () => {
  it('keeps title plus text within maxChars and truncates the last section with an ellipsis', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'a.md'), `## 一\nkw ${'x'.repeat(300)}\n## 二\nkw ${'y'.repeat(300)}\n## 三\nkw ${'z'.repeat(300)}\n`);
    const result = await run(docs, { text: 'kw', topics: ['kw'], docs: ['a.md'], maxChars: 500 });
    const total = result.items.reduce((sum, item) => sum + item.title.length + item.text.length, 0);
    expect(total).toBeLessThanOrEqual(500);
    expect(result.items.length).toBe(2);
    expect(result.items[0]!.text).not.toMatch(/…$/);
    expect(result.items[1]!.text).toMatch(/…$/);
  });

  it('keeps filling after a section is only cut by the 4000-character item cap', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'a.md'), `## 一\nkw kw kw ${'x'.repeat(5000)}\n## 二\nkw 短段\n`);
    const result = await run(docs, { text: 'kw', topics: ['kw'], docs: ['a.md'], maxChars: 6000 });
    expect(result.items.map(item => item.id)).toEqual(['a.md#0', 'a.md#1']);
    expect(result.items[0]!.text).toMatch(/…$/);
    expect(result.items[1]!.text).toContain('短段');
  });

  it('skips a section whose title alone does not fit and keeps looking', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'a.md'), `## kw ${'长'.repeat(150)}\nkw kw kw\n## kw\nok\n`);
    const result = await run(docs, { text: 'kw', topics: ['kw'], docs: ['a.md'], maxChars: 100 });
    expect(result.items.map(item => item.id)).toEqual(['a.md#1']);
  });

  it('does not split a surrogate pair when truncating', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'a.md'), `## 一\nkw ${'😀'.repeat(100)}\n`);
    const [item] = (await run(docs, { text: 'kw', topics: ['kw'], docs: ['a.md'], maxChars: 40 })).items;
    expect(item!.title.length + item!.text.length).toBeLessThanOrEqual(40);
    expect(item!.text).not.toMatch(/[\uD800-\uDBFF]…$/);
    expect(item!.text.replace(/\n/g, '')).toMatch(/…$/);
  });

  it('returns nothing when even the title does not fit', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'a.md'), '## 一\nkw\n');
    expect((await run(docs, { text: 'kw', topics: ['kw'], docs: ['a.md'], maxChars: 3 })).items).toEqual([]);
  });

  it('caps a single item at 4000 characters', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'a.md'), `## 一\nkw ${'x'.repeat(9000)}\n`);
    const [item] = (await run(docs, { text: 'kw', topics: ['kw'], docs: ['a.md'], maxChars: 16_000 })).items;
    expect(item!.text.length).toBe(4000);
  });
});

describe('team-faq: missing', () => {
  it('reports a nonexistent file, non-Markdown files and a directory without leaking the absolute path', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'ok.md'), '## 一\nkw\n');
    await write(join(docs, 'note.txt'), 'kw');
    await mkdir(join(docs, 'dir.md'));
    const result = await run(docs, { text: 'kw', topics: ['kw'], docs: ['ok.md', 'gone.md', 'note.txt', 'dir.md'] });
    expect(result.items.map(item => item.id)).toEqual(['ok.md#0']);
    expect(result.missing).toEqual(['gone.md：文件不存在或无法读取', 'note.txt：不是 Markdown 文件（.md）', 'dir.md：不是文件']);
    expect(result.missing.join('')).not.toContain(docs);
  });

  it('rejects .. segments, absolute paths and Windows-style paths', async () => {
    const { docs, outside } = await workspace();
    await write(join(outside, 'secret.md'), '## 密\nkw\n');
    const result = await run(docs, { text: 'kw', topics: ['kw'], docs: ['../outside/secret.md', join(outside, 'secret.md'), 'a/../../outside/secret.md', '..\\outside\\secret.md', 'C:\\x.md', 'a\0.md'] });
    expect(result.items).toEqual([]);
    expect(result.missing).toHaveLength(6);
    expect(result.missing.every(entry => /只允许 docs_dir 内的相对路径|路径不能包含 \.\.|路径无效/.test(entry))).toBe(true);
  });

  it('rejects symlinks to files and directories outside docs_dir', async () => {
    const { docs, outside } = await workspace();
    await write(join(outside, 'secret.md'), '## 密\nkw\n');
    await symlink(join(outside, 'secret.md'), join(docs, 'link.md'));
    await symlink(outside, join(docs, 'linkdir'));
    const result = await run(docs, { text: 'kw', topics: ['kw'], docs: ['link.md', 'linkdir/secret.md'] });
    expect(result.items).toEqual([]);
    expect(result.missing).toEqual(['link.md：路径指向 docs_dir 之外', 'linkdir/secret.md：路径指向 docs_dir 之外']);
    expect(result.missing.join('')).not.toContain(outside);
    expect(result.missing.join('')).not.toContain(docs);
  });

  it('rejects a sibling directory whose name only shares the docs_dir prefix', async () => {
    const { base, docs } = await workspace();
    await mkdir(join(base, 'docs-evil'));
    await write(join(base, 'docs-evil/x.md'), '## 密\nkw\n');
    await symlink(join(base, 'docs-evil'), join(docs, 'evil'));
    const result = await run(docs, { text: 'kw', topics: ['kw'], docs: ['evil/x.md'] });
    expect(result.items).toEqual([]);
    expect(result.missing).toEqual(['evil/x.md：路径指向 docs_dir 之外']);
  });

  it('rejects files over 1 MB', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'big.md'), `## 一\nkw ${'x'.repeat(1_000_001)}`);
    expect((await run(docs, { text: 'kw', topics: ['kw'], docs: ['big.md'] })).missing).toEqual(['big.md：文件超过 1 MB']);
  });

  it('reports unset or missing docs_dir, empty docs and ignores non-string docs entries', async () => {
    const { base, docs } = await workspace();
    await write(join(docs, 'ok.md'), '## 一\nkw\n');
    expect(await run(undefined, { text: 'kw', topics: ['kw'], docs: ['ok.md'] })).toEqual({ items: [], missing: ['插件配置 docs_dir 未设置'] });
    expect(await run(join(base, 'nope'), { text: 'kw', topics: ['kw'], docs: ['ok.md'] })).toEqual({ items: [], missing: ['docs_dir 不存在或无法读取'] });
    expect(await run(docs, { text: 'kw', topics: ['kw'], docs: [] })).toEqual({ items: [], missing: ['群参数 docs 没有填 runbook 文件'] });
    const mixed = await run(docs, { text: 'kw', topics: ['kw'], docs: ['ok.md', 'ok.md', 3, null, ' '] });
    expect(mixed.items.map(item => item.id)).toEqual(['ok.md#0']);
    expect(mixed.missing).toEqual([]);
  });
});

describe('team-faq: signal', () => {
  it('reads nothing when the signal is already aborted', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'a.md'), '## 一\nkw\n');
    await write(join(docs, 'b.md'), '## 二\nkw\n');
    const controller = new AbortController();
    controller.abort(new Error('timeout'));
    const result = await run(docs, { text: 'kw', topics: ['kw'], docs: ['a.md', 'b.md'], signal: controller.signal });
    expect(result.items).toEqual([]);
    expect(result.missing).toEqual(['a.md：未读取（已中止）', 'b.md：未读取（已中止）']);
  });

  it('stops reading further files once aborted mid-way and returns what it already has', async () => {
    const { docs } = await workspace();
    for (const name of ['a.md', 'b.md', 'c.md']) await write(join(docs, name), `## ${name}\nkw\n`);
    const controller = new AbortController();
    let reads = 0;
    hooks.afterRead = () => { reads += 1; if (reads === 1) controller.abort(new Error('timeout')); };
    try {
      const result = await run(docs, { text: 'kw', topics: ['kw'], docs: ['a.md', 'b.md', 'c.md'], signal: controller.signal });
      expect(reads).toBe(1);
      expect(result.items.map(item => item.id)).toEqual(['a.md#0']);
      expect(result.missing).toEqual(['b.md：未读取（已中止）', 'c.md：未读取（已中止）']);
    } finally { hooks.afterRead = undefined; }
  });
});

describe('team-faq: abort while reading', () => {
  it('treats an AbortError from the file read as an abort, not as a failure', async () => {
    const { docs } = await workspace();
    for (const name of ['a.md', 'b.md']) await write(join(docs, name), `## ${name}\nkw\n`);
    const controller = new AbortController();
    hooks.beforeRead = () => controller.abort(new Error('timeout'));
    try {
      const result = await run(docs, { text: 'kw', topics: ['kw'], docs: ['a.md', 'b.md'], signal: controller.signal });
      expect(result.items).toEqual([]);
      expect(result.missing).toEqual(['a.md：未读取（已中止）', 'b.md：未读取（已中止）']);
    } finally { hooks.beforeRead = undefined; }
  });
});

describe('team-faq: plugin wiring', () => {
  it('registers the runbook provider with docs_dir from the plugin config', async () => {
    const { docs } = await workspace();
    await write(join(docs, 'a.md'), '## 一\nkw\n');
    const registered: Array<{ id: string; context: (input: never) => Promise<{ items: unknown[]; missing: string[] }> }> = [];
    register({ config: { docs_dir: docs }, registerScenarioProvider: (provider: never) => registered.push(provider) } as never);
    expect(registered.map(provider => provider.id)).toEqual(['runbook']);
    const result = await registered[0]!.context({
      scope: { appId: 'app', chatId: 'c' }, message: message('kw'), params: { topics: ['kw'], docs: ['a.md'] }, maxChars: 6000, signal: new AbortController().signal
    } as never);
    expect(result.items).toHaveLength(1);
  });
});

describe('team-faq: scenario pack', () => {
  it('passes the shared static validation and wires the runbook provider', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const pack = JSON.parse(await readFile(join(root, 'scenarios/team-faq.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(root, '.dutydeck-plugin/plugin.json'), 'utf8'));
    const result = validateScenarioPack(pack);
    expect(result.issues).toEqual([]);
    expect(result.pack?.mode).toBe('model');
    expect(result.pack?.context?.provider).toBe('runbook');
    expect(manifest).toMatchObject({ name: 'team-faq', scenarios: 'scenarios', providers: 'index.mjs' });
    expect(Object.keys(manifest.userConfig)).toEqual(['docs_dir']);
  });
});
