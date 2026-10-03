import Database from 'better-sqlite3';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTH_TOKEN_CONFIG_KEY,
  SHARE_LINK_SECRET_CONFIG_KEY,
  signSessionShareToken
} from '../../../apps/server/src/auth/auth.js';

export interface SecurityCanaryDefinition {
  secret: string;
  privatePath: string;
  xssPayload: string;
}

/**
 * 直接从测试实例的 SQLite 数据库读取认证相关秘钥（只读，不污染库）。
 * 返回的 authToken 用于真实管理员对照请求，shareSecret 用于签发真实 share token。
 */
export function readAuthContextFromDb(dataDir: string): {
  authToken: string | null;
  shareSecret: string | null;
} {
  const dbPath = join(dataDir, 'dutydeck.db');
  if (!existsSync(dbPath)) {
    return { authToken: null, shareSecret: null };
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const tokenRow = db
      .prepare('SELECT value FROM configs WHERE key = ?')
      .get(AUTH_TOKEN_CONFIG_KEY) as { value: string } | undefined;
    const shareRow = db
      .prepare('SELECT value FROM configs WHERE key = ?')
      .get(SHARE_LINK_SECRET_CONFIG_KEY) as { value: string } | undefined;
    return {
      authToken: tokenRow?.value ?? null,
      shareSecret: shareRow?.value ?? null
    };
  } finally {
    db.close();
  }
}

/**
 * 使用服务真实签名函数为指定 sessionId 签发合法 share token，
 * 用于验证「share principal 不能访问 insight 路径」。
 */
export function createRealShareToken(shareSecret: string, sessionId: string): string {
  return signSessionShareToken(shareSecret, sessionId);
}

/**
 * 向专属 session 的真实原生主流日志追加包含独特 canary 的合成条目。
 * 注意：主流日志不得附加 agentId（主流 streamIdentity 为 main，带 agentId 会与 main 预期冲突）。
 */
export function appendCanariesToLog(
  mainPath: string,
  nativeSessionId: string,
  canaries: SecurityCanaryDefinition
): void {
  const toolUseEntry = {
    type: 'assistant',
    sessionId: nativeSessionId,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `Diagnostics with credential ${canaries.secret} at root ${canaries.privatePath}`
        },
        {
          type: 'tool_use',
          id: 'toolu_canary_audit_01',
          name: 'Bash',
          input: {
            command: `export SECRET_KEY="${canaries.secret}"; cat "${canaries.privatePath}"; echo '${canaries.xssPayload}'`
          }
        }
      ]
    }
  };

  const toolResultEntry = {
    type: 'user',
    sessionId: nativeSessionId,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_canary_audit_01',
          content: `Executed. Verified private root: ${canaries.privatePath}; token ${canaries.secret}; payload ${canaries.xssPayload}`
        }
      ]
    }
  };

  appendFileSync(
    mainPath,
    `${JSON.stringify(toolUseEntry)}\n${JSON.stringify(toolResultEntry)}\n`,
    'utf8'
  );
}
