// 场景包模板的渲染。模板在加载时已经过静态校验（shared/scenarios.ts：语法、每个位置允许的变量）。
// 字面文字和插进去的动态数据分开处理：包参数和宿主生成的值按类型格式化；外部来源的显示名先清洗；
// 模型输出和消息正文不作为变量进入 prompt 里的模板（上一轮结论由调用方包成不可信材料另外附上）。

import type { ScenarioPack, ScenarioParam } from '@dutydeck/shared';

/** 一个变量的值：text 是插进去的文字，present 决定 {name?有值:为空} 走哪一支。 */
export interface TemplateValue { text: string; present: boolean }
export type TemplateValues = Readonly<Record<string, TemplateValue>>;

export const templateText = (text: string): TemplateValue => ({ text, present: text.length > 0 });

/** 渲染模板：{name} 换成值，{name?有值:为空} 按 name 有没有值二选一，分支里只能再用 {name}。缺的变量按空值处理。 */
export function renderScenarioTemplate(template: string, values: TemplateValues): string {
  let index = 0;
  const readName = () => {
    const name = /^[A-Za-z][A-Za-z0-9_]*/.exec(template.slice(index))?.[0] ?? '';
    index += name.length;
    return name;
  };
  const readBranch = (end: ':' | '}') => {
    let text = '';
    while (index < template.length) {
      const char = template[index]!;
      index += 1;
      if (char === end) break;
      if (char !== '{') { text += char; continue; }
      text += values[readName()]?.text ?? '';
      index += 1;
    }
    return text;
  };
  let out = '';
  while (index < template.length) {
    const char = template[index]!;
    index += 1;
    if (char !== '{') { out += char; continue; }
    const name = readName();
    if (template[index] === '}') { index += 1; out += values[name]?.text ?? ''; continue; }
    index += 1;
    const yes = readBranch(':');
    const no = readBranch('}');
    out += values[name]?.present ? yes : no;
  }
  return out;
}

/** 外部来源的显示名（机器人名字等）：去换行和控制字符，去掉 「」【】[]<>{}，截到 64 字。插进模板后仍是单行、留在模板的引号里、不会伪造标记。 */
export function sanitizeDisplayName(name: string): string {
  return Array.from(name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ').replace(/[「」【】[\]<>{}]/gu, '').replace(/\s+/gu, ' ').trim()).slice(0, 64).join('');
}

/**
 * 卡片行里的结论（Agent 输出，给人看）：去换行，把能拼出链接、@ 和标签的 [ ] < > 换成全角，截到 120 字。
 * 结论第一句已经去掉了加粗、代码和链接写法（larkConclusionHeadline），这里只补上剩下的。
 */
export function sanitizeCardText(text: string): string {
  const plain = text.replace(/\s+/gu, ' ').trim().replace(/\[/gu, '［').replace(/\]/gu, '］').replace(/</gu, '＜').replace(/>/gu, '＞');
  const characters = Array.from(plain);
  return characters.length <= 120 ? plain : `${characters.slice(0, 119).join('')}…`;
}

/** 参数值按类型格式化：列表用「、」连接，bot_list 写成「名字（app_id）」；空列表用参数的 empty 文字（没有就是空）。 */
export function formatScenarioParam(param: ScenarioParam, value: unknown): TemplateValue {
  if (param.type === 'integer') return typeof value === 'number' ? templateText(String(value)) : templateText('');
  const items = Array.isArray(value) ? value : [];
  const parts = param.type === 'bot_list'
    ? items.map(item => item as { appId: string; name?: string }).map(item => item.name ? `${item.name}（${item.appId}）` : item.appId)
    : items.map(String);
  return parts.length ? { text: parts.join('、'), present: true } : { text: param.empty ?? '', present: false };
}

export function scenarioParamValues(pack: ScenarioPack, params: Readonly<Record<string, unknown>>): Record<string, TemplateValue> {
  return Object.fromEntries(Object.entries(pack.params).map(([name, param]) => [name, formatScenarioParam(param, params[name])]));
}

/** 包的一句话说明（status.summary）：确认卡、/status、Web 都用。 */
export const scenarioSummary = (pack: ScenarioPack, params: Readonly<Record<string, unknown>>) => renderScenarioTemplate(pack.status.summary, scenarioParamValues(pack, params));
