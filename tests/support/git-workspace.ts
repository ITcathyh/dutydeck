import { execFileSync } from 'node:child_process';

export function initGitWorkspace(cwd: string): void {
  execFileSync('git', ['init', '--quiet', '--template=', cwd]);
  execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--no-gpg-sign', '--allow-empty', '--quiet', '-m', 'Initial commit'
  ], { cwd });
}
