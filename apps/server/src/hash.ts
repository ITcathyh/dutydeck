import { createHash } from 'node:crypto';

/** sha256 十六进制摘要；字符串按 UTF-8 编码。结果会进入持久化 ID，不要改变编码。 */
export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** JSON.stringify 后取 sha256；键序敏感，需要键序无关时用 @dutydeck/runtime 的 digest。 */
export const jsonSha256 = (value: unknown) => sha256Hex(JSON.stringify(value));
