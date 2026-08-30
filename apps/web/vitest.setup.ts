import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// vitest 未开启 globals，@testing-library/react 的自动清理不会生效，这里手动挂上。
// 少了它，前一个用例的 DOM 会残留在 document.body，后续 screen.getBy* 会命中旧节点。
afterEach(() => {
  cleanup();
});
