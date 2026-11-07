import type { ConfigRepository } from '@dutydeck/shared';

/** 读多条入站记录的少数字段：SQLite 只把这些字段交给 JS；没有投影接口的存储退回整行读取。坏 JSON 的行 fields 为 undefined。 */
export async function listLarkInboxFields(store: ConfigRepository, keyPrefix: string, paths: readonly string[], states?: Array<string | null>) {
  if (store.listJsonFields) return store.listJsonFields(keyPrefix, paths, states && { field: 'state', values: states });
  const decode = (value: string) => { try { return JSON.parse(value) as Record<string, unknown> | null; } catch { return undefined; } };
  return (await store.list!(keyPrefix)).map(row => ({ key: row.key, value: decode(row.value) }))
    .filter(row => !states || states.includes(typeof row.value?.state === 'string' ? row.value.state : null))
    .map(row => ({ key: row.key, fields: row.value && typeof row.value === 'object' ? pickInboxFields(row.value, paths) : undefined }));
}

/** 按点路径从已解析的入站记录里取字段，键就是路径本身。 */
export const pickInboxFields = (record: unknown, paths: readonly string[]) =>
  Object.fromEntries(paths.map(path => [path, path.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], record)]));
