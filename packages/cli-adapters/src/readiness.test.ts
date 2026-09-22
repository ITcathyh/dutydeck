import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCodexAdapter } from './adapters/codex.js';
import { createTraexAdapter } from './adapters/traex.js';
import type { PtyLike } from './types.js';

const SID = 'test-session-1111-2222';

interface MockBackend extends PtyLike {
  writes: string[];
  specialKeys: string[][];
  screenText: string;
}

function createMockBackend(initialScreen: string): MockBackend {
  const backend: MockBackend = {
    screenText: initialScreen,
    writes: [],
    specialKeys: [],
    readScreen() {
      return backend.screenText;
    },
    write(data: string) {
      backend.writes.push(data);
    },
    sendSpecialKeys(...keys: string[]) {
      backend.specialKeys.push(keys);
    },
  };
  return backend;
}

describe('Codex prepareInput readiness', () => {
  describe('真实 native fixtures 正例表驱动测试', () => {
    for (const name of ['native-1', 'native-2', 'native-3']) {
      it(`一次性通过真实视口 fixture: ${name}`, async () => {
        const fixturePath = join(__dirname, `fixtures/codex-resume/${name}.json`);
        const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { screen: string };
        const adapter = createCodexAdapter();
        const backend = createMockBackend(fixture.screen);

        await expect(adapter.prepareInput!(backend, { sessionId: SID })).resolves.toBeUndefined();
        expect(backend.writes).toHaveLength(0);
        expect(backend.specialKeys).toHaveLength(0);
      });
    }
  });

  describe('旧 banner 与 Context footer 兼容正例', () => {
    it('兼容极简旧 banner: Codex\\n› Ask Codex', async () => {
      const adapter = createCodexAdapter();
      const backend = createMockBackend('Codex\n› Ask Codex');
      await expect(adapter.prepareInput!(backend, { sessionId: SID })).resolves.toBeUndefined();
      expect(backend.writes).toHaveLength(0);
      expect(backend.specialKeys).toHaveLength(0);
    });

    it('兼容 0.154 Context footer 视口', async () => {
      const adapter = createCodexAdapter();
      const screen = [
        '› Ask Codex to do anything',
        '  gpt-6-astra low · Context 85% used · weekly 38% left',
      ].join('\n');
      const backend = createMockBackend(screen);
      await expect(adapter.prepareInput!(backend, { sessionId: SID })).resolves.toBeUndefined();
    });

    it('兼容完整已加载 banner 视口', async () => {
      const adapter = createCodexAdapter();
      const screen = [
        '╭─────────────────────────────────────────╮',
        '│ >_ OpenAI Codex (v0.154.0)              │',
        '│ model:     gpt-5.5    /model to change  │',
        '│ directory: /tmp/workspace               │',
        '╰─────────────────────────────────────────╯',
        '› Ask Codex',
      ].join('\n');
      const backend = createMockBackend(screen);
      await expect(adapter.prepareInput!(backend, { sessionId: SID })).resolves.toBeUndefined();
    });

    it('状态从 pending loading 转为 ready 时正常返回', async () => {
      vi.useFakeTimers();
      try {
        const adapter = createCodexAdapter();
        const backend = createMockBackend([
          '│ model: loading │',
          '│ directory: loading │',
          '› Ask Codex',
        ].join('\n'));

        let resolved = false;
        const pending = adapter.prepareInput!(backend, { sessionId: SID }).then(() => {
          resolved = true;
        });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(resolved).toBe(false);

        backend.screenText = [
          '│ model: gpt-5.5 │',
          '│ directory: /tmp/workspace │',
          '› Ask Codex',
        ].join('\n');

        await vi.advanceTimersByTimeAsync(150);
        await pending;
        expect(resolved).toBe(true);
        expect(backend.writes).toHaveLength(0);
        expect(backend.specialKeys).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('五大核心反例与超时保护', () => {
    const counterExamples = [
      {
        name: 'resuming',
        screen: [
          'Resuming session…',
          '› Ask Codex to do anything',
          '  custom-model · /tmp/project',
        ].join('\n'),
      },
      {
        name: 'busy (Working esc to interrupt)',
        screen: [
          'Working (esc to interrupt)',
          '› Ask Codex to do anything',
          '  custom-model · /tmp/project',
        ].join('\n'),
      },
      {
        name: 'capacity (Queued for capacity)',
        screen: [
          'Queued for capacity',
          '› Ask Codex to do anything',
          '  custom-model · /tmp/project',
        ].join('\n'),
      },
      {
        name: 'draft (未提交的人类草稿)',
        screen: [
          '› unfinished human draft',
          '  custom-model · /tmp/project',
        ].join('\n'),
      },
      {
        name: 'permissions (交互选择菜单)',
        screen: [
          'Select permissions',
          '› 1. Allow',
          '  2. Deny',
        ].join('\n'),
      },
    ];

    for (const { name, screen } of counterExamples) {
      it(`反例持续保持时 30s 超时抛错且无写入: ${name}`, async () => {
        vi.useFakeTimers();
        try {
          const adapter = createCodexAdapter();
          const backend = createMockBackend(screen);

          const pending = adapter.prepareInput!(backend, { sessionId: SID });
          const rejected = expect(pending).rejects.toThrow(/Codex.*就绪/);

          await vi.advanceTimersByTimeAsync(31_000);
          await rejected;

          // 核心断言：prepareInput 是只读探测，禁止自动按 Enter / 确认权限 / 写入
          expect(backend.writes).toHaveLength(0);
          expect(backend.specialKeys).toHaveLength(0);
        } finally {
          vi.useRealTimers();
        }
      });
    }

    it('即便有 loaded banner，如果下方存在权限弹窗/编号菜单也必须被挡并超时', async () => {
      vi.useFakeTimers();
      try {
        const adapter = createCodexAdapter();
        const screenWithDialog = [
          '╭─────────────────────────────────────────╮',
          '│ model:     gpt-5.5    /model to change  │',
          '│ directory: /tmp/workspace               │',
          '╰─────────────────────────────────────────╯',
          'Select permissions',
          '› 1. Allow',
          '  2. Deny',
        ].join('\n');

        const backend = createMockBackend(screenWithDialog);
        const pending = adapter.prepareInput!(backend, { sessionId: SID });
        const rejected = expect(pending).rejects.toThrow(/Codex.*就绪/);

        await vi.advanceTimersByTimeAsync(31_000);
        await rejected;
        expect(backend.writes).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('历史正文含 › 且无当前合法 composer/footer 无法通过', async () => {
      vi.useFakeTimers();
      try {
        const adapter = createCodexAdapter();
        // 历史消息中引用了 ›，后面跟随正常回答正文，底部没有 composer
        const historyScreen = [
          'Earlier messages:',
          '› Ask Codex to do anything',
          'Here is the response from assistant...',
          'Done.',
        ].join('\n');

        const backend = createMockBackend(historyScreen);
        const pending = adapter.prepareInput!(backend, { sessionId: SID });
        const rejected = expect(pending).rejects.toThrow(/Codex.*就绪/);

        await vi.advanceTimersByTimeAsync(31_000);
        await rejected;
      } finally {
        vi.useRealTimers();
      }
    });

    it('孤立的裸 › 且无任何 banner 或 footer 无法通过', async () => {
      vi.useFakeTimers();
      try {
        const adapter = createCodexAdapter();
        const backend = createMockBackend('›');
        const pending = adapter.prepareInput!(backend, { sessionId: SID });
        const rejected = expect(pending).rejects.toThrow(/Codex.*就绪/);

        await vi.advanceTimersByTimeAsync(31_000);
        await rejected;
      } finally {
        vi.useRealTimers();
      }
    });

    it('缺 readScreen 时显式失败', async () => {
      const adapter = createCodexAdapter();
      const backendWithoutScreen: PtyLike = { write() {} };
      await expect(adapter.prepareInput!(backendWithoutScreen, { sessionId: SID })).rejects.toThrow(
        /terminal screen reader/,
      );
    });
  });
});

describe('TraeX prepareInput readiness', () => {
  describe('TraeX 就绪正例', () => {
    it('标准 Ask TraeCode CLI + Context 100% left 视口立即通过', async () => {
      const adapter = createTraexAdapter();
      const screen = [
        '› Ask TraeCode CLI to do anything',
        'Context 100% left',
      ].join('\n');
      const backend = createMockBackend(screen);

      await expect(adapter.prepareInput!(backend, { sessionId: SID })).resolves.toBeUndefined();
      expect(backend.writes).toHaveLength(0);
      expect(backend.specialKeys).toHaveLength(0);
    });

    it('Claude 风格 ❯ 提示符与已加载 banner 正例通过', async () => {
      const adapter = createTraexAdapter();
      const screen = [
        '╭─────────────────────────────────────────╮',
        '│ model:     trae-v1    /model to change  │',
        '│ directory: /tmp/workspace               │',
        '╰─────────────────────────────────────────╯',
        '❯ Ask TraeCode CLI',
      ].join('\n');
      const backend = createMockBackend(screen);

      await expect(adapter.prepareInput!(backend, { sessionId: SID })).resolves.toBeUndefined();
    });

    it('TraeX 状态从 model/directory loading 切到 ready 正常返回', async () => {
      vi.useFakeTimers();
      try {
        const adapter = createTraexAdapter();
        const backend = createMockBackend([
          '│ model: loading │',
          '│ directory: loading │',
          '❯ Ask TraeCode CLI',
        ].join('\n'));

        let resolved = false;
        const pending = adapter.prepareInput!(backend, { sessionId: SID }).then(() => {
          resolved = true;
        });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(resolved).toBe(false);

        backend.screenText = [
          '│ model: claude-3-7 │',
          '│ directory: /tmp/workspace │',
          '❯ Ask TraeCode CLI',
        ].join('\n');

        await vi.advanceTimersByTimeAsync(150);
        await pending;
        expect(resolved).toBe(true);
        expect(backend.writes).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('TraeX 五大核心反例与超时保护', () => {
    const traexCounterExamples = [
      {
        name: 'loading skeleton (model loading)',
        screen: [
          '│ model: loading │',
          '│ directory: /tmp/workspace │',
          '❯ Ask TraeCode CLI to do anything',
        ].join('\n'),
      },
      {
        name: 'spinner / working activity',
        screen: [
          '⠋ Thinking longer…',
          '❯ Ask TraeCode CLI to do anything',
          'Context 100% left',
        ].join('\n'),
      },
      {
        name: 'queued for capacity',
        screen: [
          'Queued for capacity',
          '❯ Ask TraeCode CLI to do anything',
          'Context 100% left',
        ].join('\n'),
      },
      {
        name: 'draft (未提交的人类草稿)',
        screen: [
          '❯ unsent human prompt for traex',
          'Context 100% left',
        ].join('\n'),
      },
      {
        name: 'permissions / selector menu',
        screen: [
          'Review hooks',
          '❯ 1. Allow once',
          '  2. Deny',
        ].join('\n'),
      },
    ];

    for (const { name, screen } of traexCounterExamples) {
      it(`TraeX 反例持续保持时 30s 超时抛错且无写入: ${name}`, async () => {
        vi.useFakeTimers();
        try {
          const adapter = createTraexAdapter();
          const backend = createMockBackend(screen);

          const pending = adapter.prepareInput!(backend, { sessionId: SID });
          const rejected = expect(pending).rejects.toThrow(/TraeX.*就绪/);

          await vi.advanceTimersByTimeAsync(31_000);
          await rejected;

          expect(backend.writes).toHaveLength(0);
          expect(backend.specialKeys).toHaveLength(0);
        } finally {
          vi.useRealTimers();
        }
      });
    }

    it('TraeX 缺 readScreen 时显式失败', async () => {
      const adapter = createTraexAdapter();
      const backendWithoutScreen: PtyLike = { write() {} };
      await expect(adapter.prepareInput!(backendWithoutScreen, { sessionId: SID })).rejects.toThrow(
        /terminal screen reader/,
      );
    });
  });
});

describe('readiness review regressions through prepareInput', () => {
  const invalidScreens = [
    ['Codex', 'The user asked us to compare Codex with other tools.\n›'],
    ['TraeX', 'The user asked us to compare TraeX with other tools.\n❯'],
    ['Codex', 'Earlier transcript:\n› Ask Codex\nThe report says 97% left to process.'],
    ['Codex', 'Earlier transcript:\n› Ask Codex\nThe report says Context 85% used today.'],
    ['Codex', '› Ask Codex\ncustom-model · /tmp/project and more prose'],
    ['Codex', 'Resuming…\n› Ask Codex\nContext 85% used'],
    ['Codex', 'Resuming session…\n› Ask Codex\nContext 85% used'],
    ['TraeX', 'Resuming…\n❯ Ask TraeCode CLI\nContext 100% left'],
    ['TraeX', "Too many requests right now. You're in the queue\n❯ Ask TraeCode CLI\nContext 100% left"],
    ['TraeX', '⠋ Working on it…\n❯ Ask TraeCode CLI\nContext 100% left'],
  ] as const;

  it.each(invalidScreens)('%s rejects false evidence: %s', async (cli, screen) => {
    vi.useFakeTimers();
    try {
      const adapter = cli === 'Codex' ? createCodexAdapter() : createTraexAdapter();
      const backend = createMockBackend(screen);
      const rejected = expect(adapter.prepareInput!(backend, { sessionId: SID })).rejects.toThrow(/就绪/);
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(backend.writes).toEqual([]);
      expect(backend.specialKeys).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['Codex', 'Fixed the "Queued for capacity" warning.\n› Ask Codex\nContext 85% used'],
    ['Codex', 'The documentation mentions "esc to interrupt".\n› Ask Codex\nContext 85% used'],
    ['TraeX', 'Fixed the "Queued for capacity" warning.\n❯ Ask TraeCode CLI\nContext 100% left'],
    ['Codex', '›\n100% context left'],
    ['Codex', '›\n97% left'],
    ['Codex', '›\ncustom-model medium · /tmp/project · Ready'],
  ])('%s accepts actual footer after harmless prose: %s', async (cli, screen) => {
    vi.useFakeTimers();
    try {
      const backend = createMockBackend(screen);
      const adapter = cli === 'Codex' ? createCodexAdapter() : createTraexAdapter();
      await adapter.prepareInput!(backend, { sessionId: SID });
      expect(backend.writes).toEqual([]);
      expect(backend.specialKeys).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['Resuming…', 'Working (esc to interrupt)', 'Queued for capacity', '› unsent draft', 'Select permissions\n› 1. Allow'])('waits through %s and returns only after a ready viewport', async status => {
    vi.useFakeTimers();
    try {
      const backend = createMockBackend(`Codex\n› Ask Codex\n${status}`);
      let settled = false;
      const pending = createCodexAdapter().prepareInput!(backend, { sessionId: SID }).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      backend.screenText = '› Ask Codex\nContext 85% used';
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toBe(true);
      expect(backend.writes).toEqual([]);
      expect(backend.specialKeys).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
