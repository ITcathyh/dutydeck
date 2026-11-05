/** 是不是普通对象（排除 null 和数组）。 */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 普通对象原样返回，其余返回空对象。 */
export const asRecord = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
