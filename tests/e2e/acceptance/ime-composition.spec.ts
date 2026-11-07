import { test, expect } from '@playwright/test';
import { launchIsolatedTestServer, type TestServerInstance } from './harness.js';

// CDP 的 Input.imeSetComposition 让真实 Chromium 进入组字状态，此时派发的 keydown 由浏览器自己标上
// isComposing=true，等同中文输入法用回车确认候选词。页面里记下每次 keydown，证明两条路径都真的走到了。
test('输入法组字中的回车不创建分组，确认候选词之后的回车才创建', async ({ page }) => {
  const instance: TestServerInstance = await launchIsolatedTestServer('dutydeck-acc-ime-');
  try {
    await page.goto(instance.baseUrl);
    await page.getByRole('button', { name: '整理分组' }).click();
    const input = page.getByRole('textbox', { name: '新分组名称' });
    await input.click();
    await input.evaluate(element => {
      const seen: { key: string; isComposing: boolean; keyCode: number }[] = [];
      (window as unknown as { imeKeydowns: typeof seen }).imeKeydowns = seen;
      element.addEventListener('keydown', event => {
        const keyboard = event as KeyboardEvent;
        seen.push({ key: keyboard.key, isComposing: keyboard.isComposing, keyCode: keyboard.keyCode });
      }, true);
    });

    const cdp = await page.context().newCDPSession(page);
    const enter = async (windowsVirtualKeyCode: number) => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode });
    };
    const groupNames = async () => {
      const response = await instance.request('GET', '/api/workspace-groups');
      return (response.json.organization.groups as { name: string }[]).map(group => group.name);
    };

    await cdp.send('Input.imeSetComposition', { text: 'qianduan', selectionStart: 8, selectionEnd: 8 });
    await expect(input).toHaveValue('qianduan');
    await enter(13);
    await cdp.send('Input.insertText', { text: '前端组' });
    await expect(input).toHaveValue('前端组');
    // Safari 确认候选词那次 keydown 的 isComposing 已经是 false，只剩 keyCode 229。
    await enter(229);
    await page.waitForTimeout(500);
    expect(await groupNames()).toEqual([]);

    await enter(13);
    await expect.poll(groupNames).toEqual(['前端组']);
    expect(await page.evaluate(() => (window as unknown as { imeKeydowns: unknown[] }).imeKeydowns)).toEqual([
      { key: 'Enter', isComposing: true, keyCode: 13 },
      { key: 'Enter', isComposing: false, keyCode: 229 },
      { key: 'Enter', isComposing: false, keyCode: 13 }
    ]);
  } finally {
    await instance.cleanup();
  }
});
