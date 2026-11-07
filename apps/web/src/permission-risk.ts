/*
  审批卡上的风险提示：在已脱敏的命令文本里标出常见的破坏性片段。

  这只是展示层的提醒，不是授权判定——服务端的高风险规则由部署配置决定，Web 拿不到。
  命中后审批卡会要求再按一次才允许，没命中也不代表命令安全。
*/
export type RiskSegment = { text: string; risky: boolean };

const riskyPatterns: RegExp[] = [
  /\bsudo\b/g,
  /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*|--recursive\s+--force|--force\s+--recursive)\b/g,
  /\bgit\s+push\b[^\n;&|]*?(?:--force(?:-with-lease)?|\s-f)\b/g,
  /\bgit\s+reset\s+--hard\b/g,
  /\bgit\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*\b/g,
  /\bchmod\s+(?:-R\s+)?0?777\b/g,
  /\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/g,
  /\bmkfs(?:\.[a-z0-9]+)?\b/g,
  /\bdd\s+if=/g,
  /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/gi,
  /\bkubectl\s+delete\b/g,
  /\bterraform\s+destroy\b/g,
  /\b(?:shutdown|reboot)\b/g
];

/** 把命令切成普通段与风险段；没有风险段时返回整段原文。 */
export function riskSegments(command: string): RiskSegment[] {
  const ranges: Array<[number, number]> = [];
  for (const pattern of riskyPatterns) {
    pattern.lastIndex = 0;
    for (const match of command.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  }
  if (!ranges.length) return [{ text: command, risky: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const segments: RiskSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: command.slice(cursor, start), risky: false });
    segments.push({ text: command.slice(start, end), risky: true });
    cursor = end;
  }
  if (cursor < command.length) segments.push({ text: command.slice(cursor), risky: false });
  return segments;
}

export const hasRisk = (segments: RiskSegment[]) => segments.some(segment => segment.risky);
