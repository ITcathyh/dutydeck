import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCodexAdapter } from './adapters/codex.js';
import { createTraexAdapter } from './adapters/traex.js';
import { isInputReady, isTrustPrompt, TRAEX_PLACEHOLDERS } from './adapters/screen-ready-helper.js';
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

describe('upstream native startup layout compatibility', () => {
  const traex = JSON.parse(readFileSync(join(__dirname, 'fixtures/traex-startup/native.json'), 'utf8')) as { loading: string; loaded: string };

  it('holds the real TraeX loading frame then accepts its exact loaded placeholder and directory footer', async () => {
    vi.useFakeTimers();
    try {
      const backend = createMockBackend(traex.loading);
      let settled = false;
      const pending = createTraexAdapter().prepareInput!(backend, { sessionId: SID }).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      backend.screenText = traex.loaded;
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(settled).toBe(true);
      expect(backend.writes).toEqual([]);
      expect(backend.specialKeys).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('accepts the same TraeX initialized composer/footer when the banner has scrolled out', async () => {
    vi.useFakeTimers();
    try {
      const backend = createMockBackend(traex.loaded.slice(traex.loaded.indexOf('❯')));
      await createTraexAdapter().prepareInput!(backend, { sessionId: SID });
      expect(backend.writes).toEqual([]);
      expect(backend.specialKeys).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it.each(['~/Code/example', '/tmp/project'])('accepts the upstream compact Codex Context footer with directory %s', async directory => {
    vi.useFakeTimers();
    try {
      const backend = createMockBackend(`› Ask Codex to do anything\n  custom-model medium · ${directory} · Context 85% used · weekly 38% left`);
      await createCodexAdapter().prepareInput!(backend, { sessionId: SID });
      expect(backend.writes).toEqual([]);
      expect(backend.specialKeys).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('does not mistake a human filename substituted into the placeholder for an empty composer', async () => {
    vi.useFakeTimers();
    try {
      const backend = createMockBackend(traex.loaded.replace('@filename', '@actual-file.ts'));
      const rejected = expect(createTraexAdapter().prepareInput!(backend, { sessionId: SID })).rejects.toThrow(/就绪/);
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(backend.writes).toEqual([]);
      expect(backend.specialKeys).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

describe('terminal screen readiness and trust dialog handling', () => {
  const codexStartup = JSON.parse(
    readFileSync(join(__dirname, 'fixtures/codex-startup/native.json'), 'utf8'),
  ) as {
    fulltrustPretrust: string;
    untrustedAsk: string;
    hooksReview: string;
    loading: string;
    worktreePretrust: string;
    noWarning: string;
  };

  const traexVariants = JSON.parse(
    readFileSync(join(__dirname, 'fixtures/traex-startup/variants.json'), 'utf8'),
  ) as {
    defaultDirNudge: string;
    gitBranchWorktree: string;
    untrustedPretrust: string;
    untrustedAsk: string;
    hooksReview: string;
    dutydeckRepo: string;
    strippedFooter: string;
  };

  describe('screens recognized as input ready', () => {
    it('accepts Codex full-trust pre-trusted screen with warning in footer', async () => {
      vi.useFakeTimers();
      try {
        const backend = createMockBackend(codexStartup.fulltrustPretrust);
        await createCodexAdapter().prepareInput!(backend, { sessionId: SID, permissionMode: 'full-trust' });
        expect(backend.writes).toEqual([]);
        expect(backend.specialKeys).toEqual([]);
      } finally { vi.useRealTimers(); }
    });

    it('accepts Codex worktree full-trust pre-trusted screen', async () => {
      vi.useFakeTimers();
      try {
        const backend = createMockBackend(codexStartup.worktreePretrust);
        await createCodexAdapter().prepareInput!(backend, { sessionId: SID, permissionMode: 'full-trust' });
        expect(backend.writes).toEqual([]);
        expect(backend.specialKeys).toEqual([]);
      } finally { vi.useRealTimers(); }
    });

    it('accepts Codex full-trust screen whose footer has no warning suffix', async () => {
      vi.useFakeTimers();
      try {
        const backend = createMockBackend(codexStartup.noWarning);
        await createCodexAdapter().prepareInput!(backend, { sessionId: SID, permissionMode: 'full-trust' });
        expect(backend.writes).toEqual([]);
        expect(backend.specialKeys).toEqual([]);
      } finally { vi.useRealTimers(); }
    });

    it('accepts TraeX default directory with Full Access footer', async () => {
      vi.useFakeTimers();
      try {
        const backend = createMockBackend(traexVariants.defaultDirNudge);
        await createTraexAdapter().prepareInput!(backend, { sessionId: SID, permissionMode: 'full-trust' });
        expect(backend.writes).toEqual([]);
        expect(backend.specialKeys).toEqual([]);
      } finally { vi.useRealTimers(); }
    });

    it('accepts TraeX git repository with branch segment in footer', async () => {
      vi.useFakeTimers();
      try {
        const backend = createMockBackend(traexVariants.gitBranchWorktree);
        await createTraexAdapter().prepareInput!(backend, { sessionId: SID, permissionMode: 'full-trust' });
        expect(backend.writes).toEqual([]);
        expect(backend.specialKeys).toEqual([]);
      } finally { vi.useRealTimers(); }
    });

    it('accepts TraeX full-trust pre-trusted screen with truncated path', async () => {
      vi.useFakeTimers();
      try {
        const backend = createMockBackend(traexVariants.untrustedPretrust);
        await createTraexAdapter().prepareInput!(backend, { sessionId: SID, permissionMode: 'full-trust' });
        expect(backend.writes).toEqual([]);
        expect(backend.specialKeys).toEqual([]);
      } finally { vi.useRealTimers(); }
    });

    it('accepts TraeX with stripped Full Access footer', async () => {
      vi.useFakeTimers();
      try {
        const backend = createMockBackend(traexVariants.strippedFooter);
        await createTraexAdapter().prepareInput!(backend, { sessionId: SID, permissionMode: 'full-trust' });
        expect(backend.writes).toEqual([]);
        expect(backend.specialKeys).toEqual([]);
      } finally { vi.useRealTimers(); }
    });

    it.each(TRAEX_PLACEHOLDERS)('accepts TraeX placeholder: "%s"', async placeholder => {
      vi.useFakeTimers();
      try {
        const screen = traexVariants.dutydeckRepo.replace(/❯\s*Implement \{feature\}/, `❯ ${placeholder}`);
        const backend = createMockBackend(screen);
        await createTraexAdapter().prepareInput!(backend, { sessionId: SID, permissionMode: 'full-trust' });
        expect(backend.writes).toEqual([]);
        expect(backend.specialKeys).toEqual([]);
      } finally { vi.useRealTimers(); }
    });
  });

  describe('screens recognized as not ready', () => {
    it('rejects folder trust prompt', () => {
      expect(isInputReady(codexStartup.untrustedAsk, 'Codex')).toBe(false);
      expect(isInputReady(traexVariants.untrustedAsk, 'TraeX')).toBe(false);
    });

    it('rejects hooks review prompt', () => {
      expect(isInputReady(codexStartup.hooksReview, 'Codex')).toBe(false);
      expect(isInputReady(traexVariants.hooksReview, 'TraeX')).toBe(false);
    });

    it('hooks review page in ask mode is left untouched and only fails with the generic timeout', async () => {
      vi.useFakeTimers();
      try {
        const backend = createMockBackend(traexVariants.hooksReview);
        const rejected = expect(
          createTraexAdapter().prepareInput!(backend, {
            sessionId: SID,
            cwd: '/data00/tmp/untrusted',
            permissionMode: 'ask',
          }),
        ).rejects.toThrow(/就绪/);
        await vi.advanceTimersByTimeAsync(30_000);
        await rejected;
        expect(backend.writes).toEqual([]);
        expect(backend.specialKeys).toEqual([]);
      } finally { vi.useRealTimers(); }
    });

    it('rejects numbered menu', () => {
      const menuScreen = '› 1. Option A\n  2. Option B\n  enter continue · esc quit';
      expect(isInputReady(menuScreen, 'Codex')).toBe(false);
      expect(isInputReady(menuScreen, 'TraeX')).toBe(false);
    });

    it('rejects banner still loading', () => {
      expect(isInputReady(codexStartup.loading, 'Codex')).toBe(false);
    });

    it('rejects running or pending state', () => {
      const pendingScreen = 'Working on task... esc to interrupt';
      expect(isInputReady(pendingScreen, 'Codex')).toBe(false);
      expect(isInputReady(pendingScreen, 'TraeX')).toBe(false);
    });

    it('rejects unknown user draft', () => {
      const draftScreen = traexVariants.defaultDirNudge.replace(
        /❯\s*Find and fix a bug in @filename/,
        '❯ My custom draft query that is not a placeholder',
      );
      expect(isInputReady(draftScreen, 'TraeX')).toBe(false);
    });

    it('rejects screen when regular text appears after composer', () => {
      const modified = traexVariants.defaultDirNudge.replace(
        /❯\s*Find and fix a bug in @filename/,
        '❯ Find and fix a bug in @filename\nSome extraneous prose line',
      );
      expect(isInputReady(modified, 'TraeX')).toBe(false);
    });
  });

  describe('untrusted directory prompt error in non-full-trust mode', () => {
    it('immediately throws descriptive trust error for Codex when encountering trust dialog in ask mode', async () => {
      const backend = createMockBackend(codexStartup.untrustedAsk);
      await expect(
        createCodexAdapter().prepareInput!(backend, {
          sessionId: SID,
          cwd: '/data00/tmp/untrusted',
          permissionMode: 'ask',
        }),
      ).rejects.toThrow('Codex 需要先信任工作目录 /data00/tmp/untrusted：请在终端中确认信任，或改用完全信任模式。');
    });

    it('immediately throws descriptive trust error for TraeX when encountering trust dialog in ask mode', async () => {
      const backend = createMockBackend(traexVariants.untrustedAsk);
      await expect(
        createTraexAdapter().prepareInput!(backend, {
          sessionId: SID,
          cwd: '/data00/tmp/untrusted',
          permissionMode: 'ask',
        }),
      ).rejects.toThrow('TraeX 需要先信任工作目录 /data00/tmp/untrusted：请在终端中确认信任，或改用完全信任模式。');
    });

    // 回归：信任页识别必须行锚定且在就绪判断之后。已就绪画面的对话正文里
    // 提到信任弹窗文字（agent 在讨论它，或 daemon 重连回旧 tmux 会话）时，
    // ask 模式不得报「需要先信任工作目录」。
    const traexFullAccessFooter =
      '  GPT-6-Astra xhigh · Context 100% left · ~                          ☢ Full Access (shift+tab to cycle) · ← for agents';
    const bar = '────────────────────────────────────────';

    const codexReadyWithTranscript = [
      '│ >_ OpenAI Codex (v0.156.1)                         │',
      '• 我查了一下：非完全信任模式下 Codex 会弹出 "Trust this folder?" 的确认页，需要手动确认。',
      '',
      '› Ask Codex to do anything',
      '',
      '  GPT-6-Astra xhigh · /data00/home/huangyuhang.edu/ai/dutydeck',
    ].join('\n');

    const traexReadyWithTranscript = [
      'TraeCode CLI',
      '• 提示：TraeX 首次进入目录会问 Do you trust the contents of this directory? 选 1 即可',
      bar,
      '❯ Implement {feature}',
      bar,
      traexFullAccessFooter,
    ].join('\n');

    it('a ready Codex screen whose transcript mentions "Trust this folder?" is not a trust prompt', () => {
      expect(isInputReady(codexReadyWithTranscript, 'Codex')).toBe(true);
      expect(isTrustPrompt(codexReadyWithTranscript, 'Codex')).toBe(false);
    });

    it('a ready TraeX screen whose transcript mentions the trust question is not a trust prompt', () => {
      expect(isInputReady(traexReadyWithTranscript, 'TraeX')).toBe(true);
      expect(isTrustPrompt(traexReadyWithTranscript, 'TraeX')).toBe(false);
    });

    it('ask mode resolves (does not throw) when the ready screen merely quotes trust-dialog text', async () => {
      const codexBackend = createMockBackend(codexReadyWithTranscript);
      await expect(
        createCodexAdapter().prepareInput!(codexBackend, { sessionId: SID, cwd: '/data00/x', permissionMode: 'ask' }),
      ).resolves.toBeUndefined();

      const traexBackend = createMockBackend(traexReadyWithTranscript);
      await expect(
        createTraexAdapter().prepareInput!(traexBackend, { sessionId: SID, cwd: '/data00/x', permissionMode: 'ask' }),
      ).resolves.toBeUndefined();
    });

    it('unready screen with only heading line and no menu option does not throw trust error and keeps waiting (Codex)', async () => {
      vi.useFakeTimers();
      try {
        const codexResumingWithHeadingOnly = [
          '│ >_ OpenAI Codex (v0.156.1)                         │',
          '• 我查了一下 Codex 的目录信任：',
          '  Trust this folder? 这一页在非完全信任模式下会出现，需要手动确认。',
          '',
          '  Resuming session…',
          '› Ask Codex to do anything',
        ].join('\n');

        expect(isInputReady(codexResumingWithHeadingOnly, 'Codex')).toBe(false);
        expect(isTrustPrompt(codexResumingWithHeadingOnly, 'Codex')).toBe(false);

        const codexBackend = createMockBackend(codexResumingWithHeadingOnly);
        let errorCaught: any = null;
        const pending = createCodexAdapter().prepareInput!(codexBackend, {
          sessionId: SID,
          cwd: '/data00/tmp/untrusted',
          permissionMode: 'ask',
        }).catch(err => { errorCaught = err; });

        // 推进 5 秒：绝不能过早抛出目录信任错误，而是维持等待
        await vi.advanceTimersByTimeAsync(5_000);
        expect(errorCaught).toBeNull();

        // 画面就绪后正常 resolve
        codexBackend.screenText = codexResumingWithHeadingOnly.replace('  Resuming session…\n', '') + '\n\n  custom-model medium · /data00/x';
        await vi.advanceTimersByTimeAsync(200);
        await pending;
        expect(errorCaught).toBeNull();
      } finally { vi.useRealTimers(); }
    });

    it('unready screen with only heading line and no menu option does not throw trust error and keeps waiting (TraeX)', async () => {
      vi.useFakeTimers();
      try {
        const traexResumingWithHeadingOnly = [
          'TraeCode CLI',
          '• 提示：',
          '  Do you trust the contents of this directory? 这一行被用户引用了。',
          '  Resuming session…',
          '❯ Find and fix a bug in @filename',
        ].join('\n');

        expect(isInputReady(traexResumingWithHeadingOnly, 'TraeX')).toBe(false);
        expect(isTrustPrompt(traexResumingWithHeadingOnly, 'TraeX')).toBe(false);

        const traexBackend = createMockBackend(traexResumingWithHeadingOnly);
        let errorCaught: any = null;
        const pending = createTraexAdapter().prepareInput!(traexBackend, {
          sessionId: SID,
          cwd: '/data00/tmp/untrusted',
          permissionMode: 'ask',
        }).catch(err => { errorCaught = err; });

        // 推进 5 秒：未就绪但无菜单选项，绝不能抛目录信任错误，维持等待
        await vi.advanceTimersByTimeAsync(5_000);
        expect(errorCaught).toBeNull();

        // 超时后只抛常规启动超时，不抛目录信任错误
        await vi.advanceTimersByTimeAsync(30_000);
        await pending;
        expect(errorCaught?.message).toMatch(/就绪/);
        expect(errorCaught?.message).not.toMatch(/信任/);
      } finally { vi.useRealTimers(); }
    });
  });
});
