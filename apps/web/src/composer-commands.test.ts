import { describe, expect, it } from 'vitest';
import {
  composerCapabilities,
  composerCommandRegistry,
  isComposerCommandAvailable,
  mergeComposerCommands,
  resolveComposerCommand,
  type ComposerCommandCapabilities
} from './composer-commands';

const allCapabilities: ComposerCommandCapabilities = {
  session: true, interruptible: true, hasQueued: true, recoverable: true, models: true, reasoningEfforts: true
};
const noCapabilities: ComposerCommandCapabilities = {
  session: false, interruptible: false, hasQueued: false, recoverable: false, models: false, reasoningEfforts: false
};

describe('Composer 命令注册表', () => {
  it('不再提供服务端没有实现的空壳命令', () => {
    // /goal 与 /fast 曾列在 baseCommands 里，但服务端全仓零实现，点击只是往输入框插字符串。
    // 空承诺比没有命令更糟：用户会以为自己触发了某种模式。
    const names = composerCommandRegistry.flatMap(definition => [definition.name, ...(definition.aliases ?? [])]);
    expect(names).not.toContain('goal');
    expect(names).not.toContain('fast');
  });

  it('每条命令都有「动作 + 对象 + 预期结果」的描述，不用空动词', () => {
    for (const definition of composerCommandRegistry) {
      expect(definition.description.length).toBeGreaterThan(4);
      expect(definition.description).not.toMatch(/^(处理|继续|管理)$/);
    }
  });

  it('带能力门的命令必须同时给出不可用原因，说清缺的是什么', () => {
    for (const definition of composerCommandRegistry) {
      if (!definition.requires) continue;
      expect(definition.unavailableReason, `${definition.name} 缺 unavailableReason`).toBeTruthy();
      expect(isComposerCommandAvailable(definition, allCapabilities)).toBe(true);
      expect(isComposerCommandAvailable(definition, noCapabilities)).toBe(false);
    }
  });

  it('/cancel 保留与飞书一致的 stop 别名', () => {
    expect(resolveComposerCommand('stop')).toBe(resolveComposerCommand('cancel'));
    expect(resolveComposerCommand('CANCEL')?.name).toBe('cancel');
  });

  it('重新启动命令叫 /restart 而不是 /retry，且描述必须点明上下文会清空', () => {
    // 飞书 /retry 重发同一条 prompt 并保留 session 上下文；
    // Web restart 走 driver.start() 起全新进程，上下文不会带过来。
    // 同名会让用户以为能接着上次继续——与 commit f7a5e10 修掉的「重启说反话」同源。
    expect(resolveComposerCommand('retry')).toBeUndefined();
    const restart = resolveComposerCommand('restart');
    expect(restart?.description).toContain('空白上下文');
  });

  it('/file /model /reasoning /new /help 不因没有打开任务而消失', () => {
    // 能力门只控「可不可用」，不控「在不在列表里」：命令消失会让用户以为自己记错了。
    const merged = mergeComposerCommands([], noCapabilities);
    for (const name of ['file', 'model', 'reasoning', 'new', 'help', 'status', 'cancel', 'restart']) {
      expect(merged.find(command => command.name === name), `${name} 不应从列表消失`).toBeDefined();
    }
  });

  it('归档任务的所有会话作用域能力都为 false', () => {
    // 与 ui.tsx:effectiveStatus 的「归档优先」判据一致：归档是只读终态，
    // 盖掉 session.state 记下的那个瞬间。
    const archived = composerCapabilities({
      session: { state: 'thinking', archivedAt: '2026-09-01T00:00:00Z' },
      queuedCount: 3, models: 5, reasoningEfforts: 2
    });
    expect(archived).toEqual({
      session: false, interruptible: false, hasQueued: false, recoverable: false, models: false, reasoningEfforts: false
    });
  });

  it('没有打开任务时会话作用域能力全部为 false', () => {
    expect(composerCapabilities({ queuedCount: 0, models: 3, reasoningEfforts: 1 }).session).toBe(false);
    expect(composerCapabilities({ queuedCount: 0, models: 3, reasoningEfforts: 1 }).models).toBe(false);
  });

  it('按运行状态推导中断与重启能力', () => {
    const thinking = composerCapabilities({ session: { state: 'thinking' }, queuedCount: 0, models: 0, reasoningEfforts: 0 });
    expect(thinking.interruptible).toBe(true);
    expect(thinking.recoverable).toBe(false);

    const failed = composerCapabilities({ session: { state: 'failed' }, queuedCount: 0, models: 0, reasoningEfforts: 0 });
    expect(failed.interruptible).toBe(false);
    expect(failed.recoverable).toBe(true);

    const stopped = composerCapabilities({ session: { state: 'stopped' }, queuedCount: 0, models: 0, reasoningEfforts: 0 });
    expect(stopped.recoverable).toBe(true);
  });

  it('只有排队指令、没有执行中步骤时 /cancel 仍可用', () => {
    const capabilities = composerCapabilities({ session: { state: 'idle' }, queuedCount: 2, models: 0, reasoningEfforts: 0 });
    expect(capabilities.interruptible).toBe(false);
    expect(capabilities.hasQueued).toBe(true);
    expect(isComposerCommandAvailable(resolveComposerCommand('cancel')!, capabilities)).toBe(true);
  });

  it('合并结果透出 aliases，供调用方把别名纳入检索', () => {
    // 别名不参与过滤时，输入 /stop 找不到 cancel，别名等于不存在。
    const merged = mergeComposerCommands([], allCapabilities);
    expect(merged.find(command => command.name === 'cancel')?.aliases).toContain('stop');
    expect(merged.find(command => command.name === 'file')?.aliases).toEqual([]);
  });

  it('Agent 声明的命令合并进来，但不覆盖同名内建命令', () => {
    const merged = mergeComposerCommands(
      [{ name: 'status', description: 'Agent 自己的 status' }, { name: 'compact', description: '压缩上下文' }],
      allCapabilities
    );
    expect(merged.filter(command => command.name === 'status')).toHaveLength(1);
    expect(merged.find(command => command.name === 'status')?.action).toBe('status');
    expect(merged.find(command => command.name === 'compact')).toMatchObject({ action: 'insert', available: true });
  });

  it('Agent 声明的命令用别名撞车时也不覆盖内建命令', () => {
    const merged = mergeComposerCommands([{ name: 'stop', description: 'Agent 自己的 stop' }], allCapabilities);
    expect(merged.filter(command => command.name === 'stop')).toHaveLength(0);
    expect(merged.find(command => command.name === 'cancel')?.action).toBe('cancel');
  });

  it('Agent 命令没有描述时给出兜底文案', () => {
    const merged = mergeComposerCommands([{ name: 'custom', description: '' }], allCapabilities);
    expect(merged.find(command => command.name === 'custom')?.description).toBe('Agent 提供的命令');
  });
});
