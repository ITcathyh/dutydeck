import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writePlugin(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** 最小的 direct 场景包，只用于测试加载。 */
export const directPack = (id: string, extra: Record<string, unknown> = {}) => ({
  id, version: '1.0.0', title: '测试场景', noun: '测试', description: '只用于测试加载。', mode: 'direct',
  params: {
    sources: { type: 'bot_list', label: '来源', maxItems: 5, role: 'source' },
    hours: { type: 'integer', label: '窗口', min: 1, max: 24, default: 6 },
    perHour: { type: 'integer', label: '上限', min: 1, max: 10, default: 3 }
  },
  trigger: { senderKinds: ['bot'], sourceBotsParam: 'sources' },
  execution: { instruction: '处理「{source}」发的消息。' },
  dedupe: { algorithm: 'source_text_v1' }, dedupeWindowHoursParam: 'hours', quota: { perHourParam: 'perHour' },
  confirm: { enableTitle: '开启测试场景', disableTitle: '关闭测试场景', enableSummary: '{summary}', disableSummary: '{summary}', enabledResult: '已开启：{summary}', disabledResult: '已关闭测试场景' },
  status: { summary: '来源 {sources}', actedLabel: '处理' },
  ...extra
});

/** 引用 provider `pick` 的包。 */
export const providerPack = (id: string) => directPack(id, { trigger: { senderKinds: ['bot'], sourceBotsParam: 'sources', match: { provider: 'pick' } } });

/** providers 入口：import 时写标记文件，注册 provider `pick`（match 命中含 boom 的消息）。 */
export const markerProviders = (marker: string, body = `api.registerScenarioProvider({ id: 'pick', match: ({ message }) => ({ matched: message.text.includes('boom'), dedupeKey: 'k' }) });`) =>
  `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'imported');\nexport default function register(api) { ${body} }\n`;

export const scenarioMessage = (text: string) => ({ messageId: 'om_1', chatId: 'oc_1', senderKind: 'bot' as const, senderAppId: 'cli_source', messageType: 'text', text, mentionsSelf: false, mentionsOther: false });
