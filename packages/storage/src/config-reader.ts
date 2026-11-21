import type Database from 'better-sqlite3';
import type { ConfigReader } from '@dutydeck/shared';
import { cachedStatement } from './statement-cache.js';

export function createConfigReader(sqlite: Database.Database): ConfigReader {
  return {
    get(key) { return (cachedStatement(sqlite, 'SELECT value FROM configs WHERE key=?').get(key) as { value: string } | undefined)?.value; },
    list(prefix, options) {
      if (options?.ignoreAsciiCase) {
        return cachedStatement(sqlite, 'SELECT key, value FROM configs WHERE substr(key,1,length(?)) = ? COLLATE NOCASE ORDER BY key').all(prefix, prefix) as Array<{ key: string; value: string }>;
      }
      const characters = Array.from(prefix);
      // SQLite length/substr stop at NUL; keep their existing edge-case semantics.
      if (!prefix || prefix.includes('\0') || characters.some(character => /^[\ud800-\udfff]$/.test(character))) {
        return cachedStatement(sqlite, 'SELECT key, value FROM configs WHERE substr(key, 1, length(?)) = ? ORDER BY key').all(prefix, prefix) as Array<{ key: string; value: string }>;
      }
      let upper: string | undefined;
      for (let index = characters.length - 1; index >= 0; index--) {
        const code = characters[index]!.codePointAt(0)!;
        if (code === 0x10ffff) continue;
        // UTF-8 BINARY order follows scalar values; skip the surrogate range.
        upper = characters.slice(0, index).join('') + String.fromCodePoint(code === 0xd7ff ? 0xe000 : code + 1);
        break;
      }
      return (upper === undefined
        ? cachedStatement(sqlite, 'SELECT key, value FROM configs WHERE key >= ? COLLATE BINARY AND substr(key, 1, length(?)) = ? ORDER BY key').all(prefix, prefix, prefix)
        : cachedStatement(sqlite, 'SELECT key, value FROM configs WHERE key >= ? COLLATE BINARY AND key < ? COLLATE BINARY AND substr(key, 1, length(?)) = ? ORDER BY key').all(prefix, upper, prefix, prefix)) as Array<{ key: string; value: string }>;
    }
  };
}
