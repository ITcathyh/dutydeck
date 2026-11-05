/** 是不是普通对象（排除 null 和数组）。 */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 普通对象原样返回，其余返回空对象。 */
export const asRecord = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

/** Error 取 message，其余值转字符串。 */
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** 按 /bin/sh 单引号规则整体转义（' 变为 '\''）。 */
export const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** 转义正则元字符，使字符串按字面量匹配。 */
export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
