import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, it } from 'vitest';
import { lazyBundleForTest } from '../../../tests/support/bundle-for-test.js';

const execute = promisify(execFile);
const cli = lazyBundleForTest('agent-tool-help', fileURLToPath(new URL('./cli.ts', import.meta.url)));
afterAll(async () => { await cli.cleanup(); });
describe('offline Agent tool help', () => {
  // 每条都是独立子进程启动，彼此无共享状态，并发跑以缩短文件墙钟。
  it.concurrent.for([
    [['work', '--help'], ['"steps"', 'reviewPolicy', 'kind:wait', 'workspaceMode:worktree', 'awaiting_confirmation', '不能据名称宣称工具已授权']],
    [['work', 'create', '--help'], ['idempotencyKey', 'outputStepId', 'allowedTargetStepIds', '不要轮询']],
    [['work', 'delegate', '--help'], ['"context"', 'Worker 看不到本话题历史', '仅当本轮提示明确启用 Leader 模式时适用']],
    [['collaborate', '--help'], ['followup-create', 'expectedRevision', 'localDateTime', 'everySeconds', 'deliveryPaused', 'feedback']],
    [['group', '--help'], ['--since', '500 条', 'omt_*', '幂等', 'GROUP_TOOL_AUTHORIZATION_REQUIRED', 'group handoff']],
    [['memory', '--help'], ['memory search', 'memory remove', '只在用户明确要求记住/忘记时写入', '不保存凭据']],
    [['session', 'herdr', '--help'], ['session_name/workspace_id/root_pane_id', 'pane split', 'default session', '--remote', 'stop']],
    [['session', 'ask', '--help'], ['--choices', '--multiple', '124', 'stdout']]
  ] as Array<[string[], string[]]>)('reads %j without service credentials', async ([args, expected], { expect }) => {
    const result = await execute(process.execPath, [await cli.path(), ...args], {
      env: { PATH: process.env.PATH, NODE_OPTIONS: '--conditions=development' }, timeout: 15_000
    });
    expect(result.stderr).toBe('');
    if (args[0] !== 'session' || args[1] === 'herdr') {
      expect(result.stdout).toContain('完整安装绑定命令前缀');
      expect(result.stdout).toContain('保留本轮 --turn');
    }
    for (const text of expected) expect(result.stdout).toContain(text);
  });
});
