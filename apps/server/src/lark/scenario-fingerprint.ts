// direct 场景包的两个固定算法：去重指纹 source_text_v1 和关键字过滤。都只看解析后的正文。

import { createHash } from 'node:crypto';

/**
 * 去重指纹 source_text_v1：来源 + 去掉链接、长十六进制串、数字（含全角）和空白后的正文前 2000 个 UTF-16 代码单元。
 * 时间、数值、实例号这类每次都变的部分不参与比较。结果是 sha256(JSON.stringify([sourceAppId, stable])) 的十六进制前 32 位。
 */
export function sourceTextFingerprint(sourceAppId: string, text: string): string {
  const stable = text.replace(/https?:\/\/\S+/g, '').replace(/\b[0-9a-f]{8,}\b/gi, '#').replace(/[0-9０-９]+/g, '#').replace(/\s+/g, '').slice(0, 2000);
  return createHash('sha256').update(JSON.stringify([sourceAppId, stable])).digest('hex').slice(0, 32);
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 正文里有任一个关键字（不分大小写）；英文数字关键字按整词比，「P1」不匹配「P10」。没设关键字时都算命中。宿主拼出的正则是线性的，在主线程执行。 */
export function keywordsMatch(keywords: readonly string[], text: string): boolean {
  return !keywords.length || keywords.some(keyword => (/^[a-z0-9]+$/i.test(keyword)
    ? new RegExp(`(?<![a-z0-9])${escapeRegExp(keyword)}(?![a-z0-9])`, 'i') : new RegExp(escapeRegExp(keyword), 'i')).test(text));
}
