import type Database from 'better-sqlite3';
import { makeId, type WorkspaceApprovalRule, type WorkspaceApprovalRuleRepository } from '@dutydeck/shared';
import { cachedStatement } from './statement-cache.js';

/** v46：按工作区记住的审批规则，按机器人（app_id）隔离。工作区是目录的真实路径、机器人可能已删除，都不是表里的实体，所以没有外键。
 * pattern 只约束 shared 白名单规则的形状：字母开头、由 `[A-Za-z0-9:_-]` 词以单个空格连接，可以是单个词（如 `pytest`）。 */
export function createWorkspaceApprovalRuleSchema(db: Database.Database) {
  db.exec(`CREATE TABLE workspace_approval_rules (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL CHECK(length(app_id) BETWEEN 1 AND 256),
    workspace TEXT NOT NULL CHECK(length(workspace) BETWEEN 1 AND 4096),
    pattern TEXT NOT NULL CHECK(length(pattern) BETWEEN 1 AND 1024 AND pattern GLOB '[A-Za-z]*' AND pattern NOT GLOB '*[^A-Za-z0-9:_ -]*'
      AND pattern NOT GLOB '* ' AND instr(pattern, '  ') = 0),
    created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 256),
    created_at TEXT NOT NULL,
    UNIQUE(app_id, workspace, pattern)
  );`);
}

/** 每次读都直接查表，不做缓存：撤销后下一条请求立即按没有规则处理。 */
export function createWorkspaceApprovalRuleRepository(db: Database.Database): WorkspaceApprovalRuleRepository {
  const columns = 'id,app_id AS appId,workspace,pattern,created_by AS createdBy,created_at AS createdAt';
  const find = (appId: string, workspace: string, pattern: string) => cachedStatement(db, `SELECT ${columns} FROM workspace_approval_rules WHERE app_id=? AND workspace=? AND pattern=?`).get(appId, workspace, pattern) as WorkspaceApprovalRule | undefined;
  return {
    list: (filter = {}) => cachedStatement(db, `SELECT ${columns} FROM workspace_approval_rules WHERE (@appId IS NULL OR app_id=@appId) AND (@workspace IS NULL OR workspace=@workspace) ORDER BY app_id, workspace, created_at, id`)
      .all({ appId: filter.appId ?? null, workspace: filter.workspace ?? null }) as WorkspaceApprovalRule[],
    add: input => db.transaction(() => {
      const existing = find(input.appId, input.workspace, input.pattern);
      if (existing) return existing;
      cachedStatement(db, 'INSERT INTO workspace_approval_rules(id,app_id,workspace,pattern,created_by,created_at) VALUES (?,?,?,?,?,?)')
        .run(makeId('war'), input.appId, input.workspace, input.pattern, input.createdBy, new Date().toISOString());
      return find(input.appId, input.workspace, input.pattern)!;
    }).immediate(),
    remove: id => cachedStatement(db, 'DELETE FROM workspace_approval_rules WHERE id=?').run(id).changes > 0
  };
}
