import { createConfigReader } from '@dutydeck/storage/helpers';
import Database from 'better-sqlite3';

export function readAccessToken(path: string): string | undefined {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return createConfigReader(db).get('auth.accessToken')?.trim();
  } finally {
    db.close();
  }
}
