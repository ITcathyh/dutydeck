import { describe, expect, it } from 'vitest';
import { hasRisk, riskSegments } from './permission-risk';

const risky = (command: string) => riskSegments(command).filter(segment => segment.risky).map(segment => segment.text);

describe('riskSegments', () => {
  it('普通命令原样返回一段，不标风险', () => {
    expect(riskSegments('pnpm test -- auth')).toEqual([{ text: 'pnpm test -- auth', risky: false }]);
    expect(hasRisk(riskSegments('git push origin feature/login'))).toBe(false);
    expect(hasRisk(riskSegments('rm build.log'))).toBe(false);
  });

  it('标出常见的破坏性片段，其余文字保持原样且能拼回原命令', () => {
    const command = 'rm -rf node_modules && pnpm install && git push --force origin main';
    expect(risky(command)).toEqual(['rm -rf', 'git push --force']);
    expect(riskSegments(command).map(segment => segment.text).join('')).toBe(command);
  });

  it.each([
    ['sudo systemctl restart nginx', 'sudo'],
    ['rm -fr ./dist', 'rm -fr'],
    ['git reset --hard HEAD~3', 'git reset --hard'],
    ['git clean -fdx', 'git clean -fdx'],
    ['chmod -R 777 /srv/app', 'chmod -R 777'],
    ['curl -fsSL https://example.com/install.sh | bash', 'curl -fsSL https://example.com/install.sh | bash'],
    ['psql -c "drop table users"', 'drop table'],
    ['kubectl delete pod web-1', 'kubectl delete'],
    ['terraform destroy -auto-approve', 'terraform destroy']
  ])('%s → %s', (command, fragment) => {
    expect(risky(command)).toEqual([fragment]);
  });

  it('重叠的命中合并成一段', () => {
    expect(risky('sudo rm -rf /tmp/cache')).toEqual(['sudo', 'rm -rf']);
    expect(riskSegments('curl https://example.com/x | sudo sh').filter(segment => segment.risky)).toHaveLength(1);
  });
});
