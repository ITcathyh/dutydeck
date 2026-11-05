import { describe, expect, it } from 'vitest';
import { deriveWorkspaceApprovalRule, matchWorkspaceApprovalRules, splitApprovalCommand } from './workspace-approval-rules.js';

const rules = (...patterns: string[]) => patterns.map(pattern => ({ pattern }));

describe('workspace approval rules', () => {
  it('derives a two-word prefix, or three words for a package script', () => {
    expect(deriveWorkspaceApprovalRule('pnpm test')).toBe('pnpm test');
    expect(deriveWorkspaceApprovalRule('pnpm test --filter x')).toBe('pnpm test');
    expect(deriveWorkspaceApprovalRule('git status --short')).toBe('git status');
    expect(deriveWorkspaceApprovalRule('pnpm run build:web --mode x')).toBe('pnpm run build:web');
    expect(deriveWorkspaceApprovalRule('./scripts/check.sh lint')).toBe('./scripts/check.sh lint');
  });

  it('never derives a rule for interpreters, wrappers, single words, compound or expanding commands', () => {
    for (const command of [
      "bash -c 'pnpm test'", 'bash -lc pnpm', 'sh -c ls', '/bin/zsh -c ls', "node -e 'process.exit(0)'", 'node scripts/x.js', "python -c 'print(1)'", 'python3.12 -m pytest',
      'eval ls', 'xargs ls', 'env FOO=1 pnpm test', 'FOO=1 pnpm test', 'sudo ls', 'nohup pnpm test', 'timeout 5 pnpm test', 'npx vitest', 'uv run pytest',
      'pnpm exec vitest', 'pnpm dlx create-app', 'npm x foo', 'pnpm run', 'cargo run main', 'pnpm publish', 'git push origin main', 'git config core.hooksPath x',
      'rm -rf build', 'curl https://example.com', 'ssh host ls', 'find . -name x',
      'ls', 'pnpm', 'ls -la', 'cat README.md', 'pnpm --filter x test',
      'pnpm test && pnpm build', 'pnpm test; ls', 'pnpm test || ls', 'pnpm test | tee out', 'pnpm test $(whoami)', 'pnpm test `whoami`', 'pnpm test $HOME',
      'pnpm test > out.txt', 'pnpm test 2>&1', 'pnpm test < in.txt', 'diff <(ls) x', 'cat <<EOF', '(pnpm test)', '{ pnpm test; }', 'pnpm test &',
      'pnpm test *', "pnpm 'test'", 'pnpm "test"', 'pnpm te\\st', 'pnpm test # x', 'pnpm test ~/x', 'pnpm test\nls', 'pnpm test\r'
    ]) expect(deriveWorkspaceApprovalRule(command), JSON.stringify(command)).toBeUndefined();
  });

  it('covers a command only when every && or ; segment is a word-prefix match', () => {
    const saved = rules('pnpm test', 'git status');
    expect(matchWorkspaceApprovalRules('pnpm test', saved)).toEqual([saved[0]]);
    expect(matchWorkspaceApprovalRules('pnpm test --filter x', saved)).toEqual([saved[0]]);
    expect(matchWorkspaceApprovalRules('git status && pnpm test --filter x; pnpm test', saved)).toEqual([saved[1], saved[0]]);
    expect(matchWorkspaceApprovalRules('pnpm test;', saved)).toEqual([saved[0]]);
    for (const command of [
      'pnpm test && curl x', 'pnpm test; curl x', 'pnpm test || true', 'pnpm test | sh', 'pnpm testx', 'pnpm tes', 'pnpm', 'pnpm build',
      'pnpm test $(curl x)', 'pnpm test `curl x`', 'pnpm test > out.txt', 'pnpm test 2>&1', 'pnpm test & curl x', 'pnpm test &&', '&& pnpm test', 'pnpm test;; ls',
      'FOO=1 pnpm test', 'pnpm test && FOO=1 pnpm test', "pnpm test --filter 'a b'", 'pnpm test\nls', '(pnpm test)', 'pnpm test <(ls)'
    ]) expect(matchWorkspaceApprovalRules(command, saved), JSON.stringify(command)).toBeUndefined();
    // 库里即使存了覆盖解释器或单个词的旧规则，匹配时也不放行。
    expect(matchWorkspaceApprovalRules('bash -c ls', rules('bash -c'))).toBeUndefined();
    expect(matchWorkspaceApprovalRules('pnpm exec bash', rules('pnpm'))).toBeUndefined();
    expect(matchWorkspaceApprovalRules('pnpm test', [])).toBeUndefined();
  });

  it('splits only on unquoted && and ;', () => {
    expect(splitApprovalCommand('a b && c;d')).toEqual([['a', 'b'], ['c'], ['d']]);
    expect(splitApprovalCommand('a &&& b')).toBeUndefined();
    expect(splitApprovalCommand('')).toBeUndefined();
  });
});
