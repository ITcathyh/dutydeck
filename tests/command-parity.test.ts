import { describe, expect, it } from 'vitest';
import { larkCommandRegistry } from '../apps/server/src/lark/commands.js';
import { composerCommandRegistry } from '../apps/web/src/composer-commands.js';

/**
 * 飞书命令与 Web Composer 命令的跨端一致性。
 *
 * 两端各有一份注册表（能力边界不同，强行共享会让某一端出现永远 unavailable 的命令），
 * 共享的是**设计模式**：真实能力支撑、诚实门控、原因说清。这份测试守住那个模式，
 * 以及两端之间刻意的同名与刻意的不同名。
 *
 * 改任何一端的命令表时，这份测试会告诉你另一端要不要跟着改。
 */
describe('飞书与 Web 命令体系对齐', () => {
  const larkNames = new Set(larkCommandRegistry.flatMap(definition => [definition.name, ...(definition.aliases ?? [])]));
  const webNames = new Set(composerCommandRegistry.flatMap(definition => [definition.name, ...(definition.aliases ?? [])]));

  it('两端共有的命令名指向同一件事', () => {
    // help / status / cancel(+stop) / new 在两端都存在，语义必须一致。
    for (const shared of ['help', 'status', 'cancel', 'stop', 'new']) {
      expect(larkNames.has(shared), `飞书缺少 ${shared}`).toBe(true);
      expect(webNames.has(shared), `Web 缺少 ${shared}`).toBe(true);
    }
  });

  it('retry 只属于飞书，Web 用 restart，两者不得互相出现', () => {
    // 飞书 /retry：重发同一条 prompt，保留 session 上下文。
    // Web /restart：driver.start() 起全新进程，上下文清空。
    // 这是两个不同的动作，任何一端出现对方的名字都是语义污染。
    expect(larkNames.has('retry')).toBe(true);
    expect(larkNames.has('restart')).toBe(false);
    expect(webNames.has('restart')).toBe(true);
    expect(webNames.has('retry')).toBe(false);
  });

  it('两端的 cancel 都带 stop 别名', () => {
    expect(larkCommandRegistry.find(definition => definition.name === 'cancel')?.aliases).toContain('stop');
    expect(composerCommandRegistry.find(definition => definition.name === 'cancel')?.aliases).toContain('stop');
  });

  it('两端带能力门的命令都必须给出不可用原因', () => {
    // 这是两端共享的诚实约束：命令可以不可用，但必须说清缺的是什么。
    for (const definition of larkCommandRegistry) {
      if (definition.requires) expect(definition.unavailableReason, `飞书 ${definition.name}`).toBeTruthy();
    }
    for (const definition of composerCommandRegistry) {
      if (definition.requires) expect(definition.unavailableReason, `Web ${definition.name}`).toBeTruthy();
    }
  });

  it('两端都不提供服务端零实现的空壳命令', () => {
    for (const ghost of ['goal', 'fast']) {
      expect(larkNames.has(ghost), `飞书不应有 ${ghost}`).toBe(false);
      expect(webNames.has(ghost), `Web 不应有 ${ghost}`).toBe(false);
    }
  });
});
