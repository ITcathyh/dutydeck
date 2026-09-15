import Database from 'better-sqlite3';
import { createRepositories } from '../src/index.ts';
const [path, point] = process.argv.slice(2);
if (point === 'schema') {
  const exec = Database.prototype.exec;
  Database.prototype.exec = function (sql) {
    const result = exec.call(this, sql);
    if (sql.includes('CREATE TABLE execution_authority')) process.kill(process.pid, 'SIGKILL');
    return result;
  };
} else {
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith('UPDATE execution_authority')) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { const result = run(...args); process.kill(process.pid, 'SIGKILL'); return result; };
    }
    return statement;
  };
}
const repos = createRepositories(path!, { newDatabaseAuthority: 'ledger_v1' });
repos.close();
throw new Error('Expected SIGKILL before bootstrap commit');
