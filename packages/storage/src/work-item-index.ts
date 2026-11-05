import type Database from 'better-sqlite3';
import { cachedStatement } from './database-control.js';
import type { RepositoryBundle } from '@dutydeck/shared';

/** Derived from the existing config JSON; triggers keep CAS and scheduling atomic. */
export function createWorkItemIndexSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS configs(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE work_item_index (
      config_key TEXT PRIMARY KEY REFERENCES configs(key) ON DELETE CASCADE ON UPDATE CASCADE,
      parent_session_id TEXT, needs_tick INTEGER NOT NULL, active_steps INTEGER NOT NULL
    );
    CREATE INDEX work_item_index_scheduled ON work_item_index(config_key) WHERE needs_tick=1;
    CREATE INDEX work_item_index_active ON work_item_index(active_steps) WHERE active_steps>0;
    CREATE INDEX work_item_index_parent ON work_item_index(parent_session_id,config_key);
    CREATE TABLE work_item_sessions (
      session_id TEXT NOT NULL, config_key TEXT NOT NULL REFERENCES work_item_index(config_key) ON DELETE CASCADE ON UPDATE CASCADE,
      PRIMARY KEY(session_id,config_key)
    );
  `);
  // The outer migration transaction commits the backfill and schema_migrations marker together.
  db.exec(project('configs', "substr(key,1,10)='work_item:'"));
  createWorkItemIndexTriggers(db);
}

const project = (source: string, where: string) => `
    INSERT INTO work_item_index(config_key,parent_session_id,needs_tick,active_steps)
    SELECT config_key,json_extract(document,'$.item.parentSessionId'),
      CASE WHEN json_extract(document,'$.item.status')='cancelled' THEN 0
        WHEN json_extract(document,'$.item.status')='completed'
          AND COALESCE(json_extract(document,'$.item.delivery.status'),'not_requested') NOT IN ('pending','error') THEN 0
        ELSE 1 END,
      (SELECT COUNT(*) FROM json_each(document,'$.item.steps') step
       WHERE json_extract(CASE WHEN step.type='object' THEN step.value ELSE '{}' END,'$.status')='running'
         OR (json_extract(CASE WHEN step.type='object' THEN step.value ELSE '{}' END,'$.status')='blocked'
           AND json_type(CASE WHEN step.type='object' THEN step.value ELSE '{}' END,'$.attempts[#-1].sessionId')='text'
           AND NOT EXISTS (SELECT 1 FROM json_each(document,'$.stoppedAttempts') stopped
             WHERE stopped.value=json_extract(CASE WHEN step.type='object' THEN step.value ELSE '{}' END,'$.attempts[#-1].id'))))
    FROM (SELECT key AS config_key,CASE WHEN json_valid(value) THEN value ELSE '{}' END AS document FROM ${source} WHERE ${where});
    ${projectSessions(source, where)}
`;

/** 计划修订删掉的步骤移到 retiredSteps，其子会话仍归属原工作项。 */
const projectSessions = (source: string, where: string) => ['$.item.steps', '$.item.retiredSteps'].map(path => `
    INSERT OR IGNORE INTO work_item_sessions(session_id,config_key)
    SELECT json_extract(CASE WHEN attempt.type='object' THEN attempt.value ELSE '{}' END,'$.sessionId'),config_key
    FROM (SELECT key AS config_key,CASE WHEN json_valid(value) THEN value ELSE '{}' END AS document FROM ${source} WHERE ${where}),
      json_each(document,'${path}') step,
      json_each(CASE WHEN step.type='object' THEN step.value ELSE '{}' END,'$.attempts') attempt
    WHERE json_type(CASE WHEN attempt.type='object' THEN attempt.value ELSE '{}' END,'$.sessionId')='text';`).join('\n');

/** 重建触发器并补齐 retiredSteps 的子会话归属；已有索引行保持不变。 */
export function refreshWorkItemIndexTriggers(db: Database.Database): void {
  db.exec('DROP TRIGGER IF EXISTS work_item_config_insert; DROP TRIGGER IF EXISTS work_item_config_update; DROP TRIGGER IF EXISTS work_item_config_delete;');
  db.exec(projectSessions('configs', "substr(key,1,10)='work_item:' AND key IN (SELECT config_key FROM work_item_index)"));
  createWorkItemIndexTriggers(db);
}

function createWorkItemIndexTriggers(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER work_item_config_insert AFTER INSERT ON configs WHEN substr(new.key,1,10)='work_item:' BEGIN
      ${project('(SELECT new.key AS key,new.value AS value)', '1')}
    END;
    CREATE TRIGGER work_item_config_update AFTER UPDATE OF key,value ON configs
      WHEN substr(old.key,1,10)='work_item:' OR substr(new.key,1,10)='work_item:' BEGIN
      DELETE FROM work_item_sessions WHERE config_key IN (old.key,new.key);
      DELETE FROM work_item_index WHERE config_key IN (old.key,new.key);
      ${project('(SELECT new.key AS key,new.value AS value)', "substr(key,1,10)='work_item:'")}
    END;
    CREATE TRIGGER work_item_config_delete AFTER DELETE ON configs WHEN substr(old.key,1,10)='work_item:' BEGIN
      DELETE FROM work_item_sessions WHERE config_key=old.key;
      DELETE FROM work_item_index WHERE config_key=old.key;
    END;
  `);
}

export function createWorkItemIndexRepository(db: Database.Database): RepositoryBundle['workItems'] {
  return {
    async listScheduledIds() {
      return (cachedStatement(db, 'SELECT substr(config_key,11) AS id FROM work_item_index WHERE needs_tick=1 ORDER BY config_key').all() as Array<{ id: string }>).map(row => row.id);
    },
    async listByParent(parentSessionId) {
      return cachedStatement(db, 'SELECT key,value FROM work_item_index JOIN configs ON key=config_key WHERE parent_session_id=? ORDER BY config_key').all(parentSessionId) as Array<{ key: string; value: string }>;
    },
    async findByChildSession(sessionId) {
      return (cachedStatement(db, 'SELECT substr(config_key,11) AS id FROM work_item_sessions WHERE session_id=? ORDER BY config_key LIMIT 1').get(sessionId) as { id: string } | undefined)?.id;
    },
    async countActiveSteps() {
      return (cachedStatement(db, 'SELECT COALESCE(SUM(active_steps),0) AS count FROM work_item_index WHERE active_steps>0').get() as { count: number }).count;
    }
  };
}
