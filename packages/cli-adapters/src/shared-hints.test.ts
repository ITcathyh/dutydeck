import { describe, expect, it } from 'vitest';
import { buildDutydeckRoutingBlock, prependRoutingBlock } from './shared-hints.js';
import { relayCommandEnvKey, relayTokenEnvKey, relayUrlEnvKey } from '@dutydeck/relay';

const relayEnv = {
  [relayUrlEnvKey]: 'http://127.0.0.1:4310/api/relay',
  [relayTokenEnvKey]: 'v1.abc.def',
  [relayCommandEnvKey]: "'/usr/bin/node' '/opt/dutydeck/dist/cli.js'"
};

describe('routing block — relay command hints', () => {
  it('teaches the real send/ask commands using the runtime absolute path', () => {
    const block = buildDutydeckRoutingBlock(undefined, relayEnv);
    // 必须是运行期算出的绝对路径形态，不能是裸 dutydeck
    expect(block).toContain("'/usr/bin/node' '/opt/dutydeck/dist/cli.js' session send");
    expect(block).toContain("'/usr/bin/node' '/opt/dutydeck/dist/cli.js' session ask");
    // 退出码契约要写进文案，否则 CLI 不知道怎么判读
    expect(block).toContain('124');
    // 与 larkGroupToolsPrompt 同样的告诫：不要改用 PATH 里的其他 dutydeck
    expect(block).toMatch(/不要改用 PATH/);
    // 不能再残留 M2 的占位文案
    expect(block).not.toContain('M2');
    expect(block).not.toContain('专用回传命令');
  });

  it('falls back to bare dutydeck when only the command prefix is missing', () => {
    const block = buildDutydeckRoutingBlock(undefined, {
      [relayUrlEnvKey]: relayEnv[relayUrlEnvKey],
      [relayTokenEnvKey]: relayEnv[relayTokenEnvKey]
    });
    expect(block).toContain('dutydeck session send');
    expect(block).toContain('dutydeck session ask');
  });

  it('omits relay instructions entirely when the session has no relay credentials', () => {
    for (const env of [undefined, {}, { [relayUrlEnvKey]: 'http://x' }, { [relayTokenEnvKey]: 'v1.a.b' }]) {
      const block = buildDutydeckRoutingBlock(undefined, env);
      // 没凭证却教 CLI 调命令 = 教它必然失败的操作
      expect(block).not.toContain('session send');
      expect(block).not.toContain('session ask');
      expect(block).toContain('直接输出文本即可');
    }
  });

  it('keeps the wrapper tags and prepends ahead of the prompt', () => {
    const block = buildDutydeckRoutingBlock(undefined, relayEnv);
    expect(block.startsWith('<dutydeck_routing>')).toBe(true);
    expect(block.trimEnd().endsWith('</dutydeck_routing>')).toBe(true);
    const prompt = prependRoutingBlock('原始任务', undefined, relayEnv);
    expect(prompt.indexOf('</dutydeck_routing>')).toBeLessThan(prompt.indexOf('原始任务'));
  });
});
