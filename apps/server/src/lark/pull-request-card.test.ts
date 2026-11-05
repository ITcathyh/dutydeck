import type { PublicPullRequest } from '@dutydeck/shared';
import { describe, expect, it } from 'vitest';
import { buildPullRequestConfirmCard, buildPullRequestFollowCard } from './pull-request-card.js';

const claimed = (patch: Partial<PublicPullRequest> = {}): PublicPullRequest => ({
  id: 'pr_1', sessionId: 'session_1', provider: 'github', providerName: 'GitHub', repository: 'group/repo', status: 'open',
  title: 'Login fix', bodySummary: '', branch: 'feature/login', target: 'main', baseSha: 'a'.repeat(40), files: [], excluded: [], commits: [],
  headSha: 'b'.repeat(40), pullRequest: { number: 12, url: 'https://git.example.com/group/repo/pull/12', label: '#12' },
  ciRounds: 0, reviewRounds: 0, claimed: true, expiresAt: '2026-11-05T10:00:00.000Z', createdAt: '2026-11-05T09:00:00.000Z', updatedAt: '2026-11-05T09:00:00.000Z',
  ...patch
});

describe('buildPullRequestFollowCard', () => {
  it('外部 PR 的标题按纯文本展示：不能 @ 所有人，也不能伪造链接', () => {
    const { markdown } = buildPullRequestFollowCard(claimed({ title: '修复 <at id=all></at> 请看 [点我](https://evil.example) **紧急**\n> 引用' }));
    expect(markdown).not.toContain('<at');
    expect(markdown).toContain('&lt;at id=all&gt;&lt;/at&gt;');
    expect(markdown).not.toContain('[点我](');
    expect(markdown).toContain('\\[点我\\]\\(https://evil.example\\)');
    expect(markdown).toContain('\\*\\*紧急\\*\\*');
    expect(markdown).not.toMatch(/\n> 引用/);
    expect(markdown).toContain('[打开](https://git.example.com/group/repo/pull/12)');
  });

  it('平台给的分支名、仓库和链接同样转义；非 http(s) 链接不展示', () => {
    const { markdown } = buildPullRequestFollowCard(claimed({
      branch: 'feat/`x`<at id=all></at>', target: 'main`[a](https://evil.example)', repository: 'group/[repo](https://evil.example)',
      pullRequest: { number: 12, url: 'javascript:alert(1)', label: '#12' }
    }));
    expect(markdown).not.toContain('<at');
    expect(markdown).toContain("`feat/'x'&lt;at id=all&gt;&lt;/at&gt;`");
    expect(markdown).toContain("`main'[a](https://evil.example)`");
    expect(markdown).toContain('group/\\[repo\\]\\(https://evil.example\\)');
    expect(markdown).not.toContain('javascript:');
    expect(markdown).not.toContain('[打开]');
  });

  it('链接里的括号被编码，不能提前结束链接目标', () => {
    const { markdown } = buildPullRequestFollowCard(claimed({ pullRequest: { number: 12, url: 'https://git.example.com/pull/12)[x](https://evil.example', label: '#12' } }));
    expect(markdown).toContain('[打开](https://git.example.com/pull/12%29[x]%28https://evil.example)');
  });
});

describe('buildPullRequestConfirmCard', () => {
  const injected = '<at id=all></at> [点我](https://evil.example)';
  const proposal = (patch: Partial<PublicPullRequest> = {}) => claimed({
    status: 'proposed', claimed: undefined, headSha: undefined, pullRequest: undefined, branch: 'dutydeck/fix-login-0a1b2c3d',
    title: 'Fix login', bodySummary: 'Fixes login timeout', files: [{ path: 'src/login.ts', additions: 3, deletions: 1, change: 'modified' }],
    commits: [{ sha: 'c'.repeat(40), subject: 'Fix login' }], excluded: [{ path: 'notes.txt', reason: 'not_session' }],
    ...patch
  });

  it('普通内容的展示不变', () => {
    const { markdown } = buildPullRequestConfirmCard(proposal({ commitsUnverified: true }));
    expect(markdown).toContain('- 源分支：`dutydeck/fix-login-0a1b2c3d`（新建');
    expect(markdown).toContain('- 目标分支：`main`');
    expect(markdown).toContain('- 标题：Fix login');
    expect(markdown).toContain('- `src/login.ts` +3 −1');
    expect(markdown).toContain(`- ${'c'.repeat(8)} Fix login`);
    expect(markdown).toContain('还不在 main 上');
    expect(markdown).toContain('本地没有 origin/main，');
    expect(markdown).toContain('- `notes.txt`：不是本会话改的');
    expect(markdown).toContain('> Fixes login timeout');
  });

  it('Agent 写的标题、提交说明、正文和文件名按纯文本展示：不能 @ 所有人，也不能伪造链接', () => {
    const { markdown } = buildPullRequestConfirmCard(proposal({
      title: `修复 ${injected}`, bodySummary: `第一行 ${injected}\n**加粗**`, branch: 'dutydeck/`x`<at id=all></at>', target: 'main<at id=all></at>',
      files: [{ path: 'src/`a`<at id=all></at>.ts', additions: 1, deletions: 0, change: 'added' }],
      commits: [{ sha: 'c'.repeat(40), subject: injected }], excluded: [{ path: '[x](https://evil.example)', reason: 'changed_after' }], commitsUnverified: true
    }));
    expect(markdown).not.toContain('<at');
    expect(markdown).not.toContain('[点我](');
    expect(markdown).toContain('- 标题：修复 &lt;at id=all&gt;&lt;/at&gt; \\[点我\\]\\(https://evil.example\\)');
    expect(markdown).toContain(`- ${'c'.repeat(8)} &lt;at id=all&gt;&lt;/at&gt; \\[点我\\]`);
    expect(markdown).toContain('> 第一行 &lt;at id=all&gt;&lt;/at&gt; \\[点我\\]');
    expect(markdown).toContain('> \\*\\*加粗\\*\\*');
    expect(markdown).toContain("- 源分支：`dutydeck/'x'&lt;at id=all&gt;&lt;/at&gt;`");
    expect(markdown).toContain("- `src/'a'&lt;at id=all&gt;&lt;/at&gt;.ts` +1 −0（新增）");
    expect(markdown).toContain('- `[x](https://evil.example)`：本会话改过');
  });
});
