// 「同一告警规则」的识别：告警包关联上一轮结论（correlation）用的 provider alert-key。
// 核心把一轮的参考材料拆成条目（每条消息一个），这里从第一张告警卡算出键；核心按 requiredFields（title）和 optionalFields（service）比较。

const alertWord = /报警|告警|alarm|alert/i;
const severityWord = /^(?:critical|warning|warn|error|fatal|info)$/i;
const statusWord = /^(?:已确认|已处理|已关单|已恢复|已解决|已认领|已升级|恢复|resolved|recovered|acked)$/i;
const dateOrTime = /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:[ T]?\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}:\d{2}(?::\d{2})?/gu;
const serviceLine = /^(?:服务|\[psm\]|psm)\s*[:：]\s*(\S+)/i;

const normalizeTitle = title => title
  // 方括号里是日期、时间、处理状态或级别时整段去掉；「[E2｜CN]」这种级别｜地域只留第一段。
  .replace(/([[【])([^\]】]*)([\]】])/gu, (_whole, open, inner, close) => {
    const head = inner.split(/[｜|]/u)[0].trim();
    if (!head || severityWord.test(head) || statusWord.test(head) || new RegExp(dateOrTime.source, 'u').test(head)) return '';
    return `${open}${head}${close}`;
  })
  .replace(dateOrTime, '')
  .replace(/\s+/gu, ' ')
  .trim()
  .toLowerCase();

/**
 * 告警的身份：规则标题去掉日期、处理状态、级别和地域，加上卡片里的「服务」（旧记录的材料里没有服务字段）。
 * 只认第一行带 [ ]、【 】或 🚨 标记、标题含报警/告警或以级别开头的条目：话题里的普通文字（「排查下报警」）和周期报告不算。
 * entries 是核心拆好的材料条目；没有告警卡时返回 undefined。
 */
export function alertKey(entries) {
  for (const entry of entries ?? []) {
    const title = entry.lines.find(line => line.trim())?.trim();
    if (!title || !/[[【]|🚨/u.test(title)) continue;
    if (!alertWord.test(title) && !/^\[(?:critical|warning|warn|error|fatal|p\d)\]/i.test(title)) continue;
    const normalized = normalizeTitle(title);
    if (!normalized) continue;
    const service = entry.lines.map(line => serviceLine.exec(line.trim())?.[1]).find(Boolean);
    return { title: normalized, ...(service ? { service: service.toLowerCase() } : {}) };
  }
  return undefined;
}

export const alertKeyProvider = { id: 'alert-key', correlationKey: ({ entries }) => alertKey(entries) };
