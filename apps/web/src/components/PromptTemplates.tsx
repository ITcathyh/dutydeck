import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { currentInstance } from '../instance';
import { requestId } from '../request-id';
import { captureDialogOpener } from '../useDialogFocus';
import { Banner, Button, Card, Dialog, Field, IconButton, Input, Textarea } from './primitives';

const MAX_TEMPLATES = 50;
const MAX_TITLE = 40;
const MAX_BODY = 20_000;
type Template = { id: string; title: string; body: string };
type Editor = Omit<Template, 'id'> & { id?: string };
type TemplateList = { templates: Template[]; volatile: boolean };
const volatileLists = new Map<string, TemplateList>();

const copy = {
  zh: {
    heading: '提示词模板', add: '新建模板', edit: '编辑模板', remove: '删除模板',
    title: '模板标题', body: '模板正文', cancel: '取消', save: '保存模板',
    required: '请填写模板标题和正文。',
    countLimit: `最多保存 ${MAX_TEMPLATES} 张自建模板。删除一张后可继续新建。`,
    titleLimit: `模板标题不能超过 ${MAX_TITLE} 个字符。`,
    bodyLimit: '模板正文不能超过 20000 个字符。',
    storageWarning: '浏览器无法保存模板。本页仍可使用，未保存的改动在刷新后会丢失。',
    builtIns: [
      { title: '修复 Bug', body: '复现问题并找出根因。实施最小修复，补上能覆盖该问题的回归测试，说明如何验证。' },
      { title: '补充测试', body: '找出当前功能缺少的关键测试。补上正常路径、边界条件和预期失败的用例，并运行受影响的测试。' },
      { title: '代码审查', body: '审查当前改动，优先找会影响正确性、兼容性或数据一致性的问题。说明触发场景、影响和代码位置。' },
      { title: '熟悉项目', body: '阅读项目文档和主要入口，梳理关键模块与数据流。列出本地启动、运行测试和排查常见问题的命令。' },
      { title: '实现新功能', body: '先核对相关入口和已有行为。实现以下需求，补充受影响的测试，并说明用户能看到的变化。' }
    ]
  },
  en: {
    heading: 'Prompt templates', add: 'New template', edit: 'Edit template', remove: 'Delete template',
    title: 'Template title', body: 'Template body', cancel: 'Cancel', save: 'Save template',
    required: 'Enter a title and body for the template.',
    countLimit: `You can save up to ${MAX_TEMPLATES} custom templates. Delete one to add another.`,
    titleLimit: `Use at most ${MAX_TITLE} characters in the title.`,
    bodyLimit: 'Use at most 20,000 characters in the body.',
    storageWarning: 'The browser could not save templates. You can use them on this page. Unsaved changes will be lost on refresh.',
    builtIns: [
      { title: 'Fix a bug', body: 'Reproduce the issue and identify the root cause. Make the smallest fix, add a regression test, and explain how you verified it.' },
      { title: 'Add tests', body: 'Find important gaps in the current tests. Cover the normal path, edge cases, and expected failures, then run the affected tests.' },
      { title: 'Review code', body: 'Review the current changes for correctness, compatibility, and data consistency. For each issue, give the scenario, impact, and code location.' },
      { title: 'Explore a project', body: 'Read the project docs and main entry points. Map the key modules and data flow, then list the commands for running, testing, and troubleshooting locally.' },
      { title: 'Build a feature', body: 'Check the relevant entry points and current behavior. Implement the requirements below, cover the changes with tests, and describe what users will see.' }
    ]
  }
};

function readTemplates(key: string): TemplateList {
  const inMemory = volatileLists.get(key);
  if (inMemory) return inMemory;
  try {
    const entries = JSON.parse(localStorage.getItem(key) ?? '[]');
    const templates: Template[] = Array.isArray(entries)
      ? entries.filter(entry => typeof entry?.id === 'string' && typeof entry.title === 'string' && typeof entry.body === 'string').slice(0, MAX_TEMPLATES)
      : [];
    return { templates, volatile: false };
  } catch {
    return { templates: [], volatile: true };
  }
}

export function PromptTemplates({ onApply, disabled }: { onApply(body: string): void; disabled: boolean }) {
  const lang = /^en(?:-|$)/i.test(navigator.language) ? 'en' : 'zh';
  const labels = copy[lang];
  const storageKey = `dutydeck.prompt-templates:${currentInstance() ?? '@local'}`;
  const [list, setList] = useState(() => readTemplates(storageKey));
  const [editor, setEditor] = useState<Editor>();
  const [error, setError] = useState('');

  function persist(templates: Template[]) {
    let volatile = false;
    try {
      localStorage.setItem(storageKey, JSON.stringify(templates));
      volatileLists.delete(storageKey);
    } catch { volatile = true; }
    const next = { templates, volatile };
    if (volatile) volatileLists.set(storageKey, next);
    setList(next);
  }

  function openEditor(template?: Template) {
    if (!template && list.templates.length >= MAX_TEMPLATES) {
      setError(labels.countLimit);
      return;
    }
    setError('');
    captureDialogOpener();
    setEditor(template ?? { title: '', body: '' });
  }

  function saveTemplate() {
    if (!editor) return;
    const title = editor.title.trim(), body = editor.body;
    if (!title || !body.trim()) return setError(labels.required);
    if ([...title].length > MAX_TITLE) return setError(labels.titleLimit);
    if ([...body].length > MAX_BODY) return setError(labels.bodyLimit);
    const template = { id: editor.id ?? requestId(), title, body };
    persist(editor.id ? list.templates.map(item => item.id === editor.id ? template : item) : [...list.templates, template]);
    setEditor(undefined);
    setError('');
  }

  return <section aria-label={labels.heading} lang={lang} className="min-w-0 space-y-2">
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-caption font-semibold text-secondary">{labels.heading}</h2>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => openEditor()} icon={<Plus size={15}/>}>{labels.add}</Button>
    </div>
    <div className="grid max-h-44 grid-cols-2 gap-2 overflow-y-auto px-0.5 py-0.5 sm:grid-cols-3 lg:grid-cols-5">
      {labels.builtIns.map(template => <Card key={template.title} padding="none" as="article">
        <Button variant="ghost" className="w-full justify-start px-3 text-left" disabled={disabled} title={template.body} onClick={() => onApply(template.body)}>
          <span className="truncate">{template.title}</span>
        </Button>
      </Card>)}
      {list.templates.map(template => <Card key={template.id} padding="none" as="article" className="col-span-2 flex items-center sm:col-span-1">
        <Button variant="ghost" className="min-w-0 flex-1 justify-start px-3 text-left" disabled={disabled} title={template.title} onClick={() => onApply(template.body)}>
          <span className="truncate">{template.title}</span>
        </Button>
        <IconButton label={`${labels.edit}：${template.title}`} disabled={disabled} onClick={() => openEditor(template)}><Pencil size={14}/></IconButton>
        <IconButton label={`${labels.remove}：${template.title}`} tone="danger" disabled={disabled} onClick={() => {
          persist(list.templates.filter(item => item.id !== template.id));
          setError('');
        }}><Trash2 size={14}/></IconButton>
      </Card>)}
    </div>
    {list.volatile && <Banner tone="warning">{labels.storageWarning}</Banner>}
    {!editor && error && <Banner tone="danger">{error}</Banner>}
    {editor && <Dialog open label={editor.id ? labels.edit : labels.add} size="sm" onClose={() => { setEditor(undefined); setError(''); }}>
      <form lang={lang} className="flex min-h-0 flex-1 flex-col" onSubmit={event => { event.preventDefault(); saveTemplate(); }}>
        <Dialog.Header><h2 className="text-title font-semibold">{editor.id ? labels.edit : labels.add}</h2></Dialog.Header>
        <Dialog.Body className="space-y-4">
          <Field label={labels.title}><Input autoFocus value={editor.title} onChange={event => setEditor({ ...editor, title: event.target.value })}/></Field>
          <Field label={labels.body}><Textarea rows={6} value={editor.body} onChange={event => setEditor({ ...editor, body: event.target.value })}/></Field>
          {error && <Banner tone="danger">{error}</Banner>}
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="secondary" onClick={() => { setEditor(undefined); setError(''); }}>{labels.cancel}</Button>
          <Button type="submit" variant="primary">{labels.save}</Button>
        </Dialog.Footer>
      </form>
    </Dialog>}
  </section>;
}
