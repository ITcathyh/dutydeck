import { vi } from 'vitest';

// vi.waitFor 默认 50ms 查一次条件，集成测试里的条件几乎都是读内存或 SQLite，一次查询远小于 1ms，
// 条件成立后却要空等到下一个 50ms。import 本文件后默认 5ms 查一次；调用处显式传的 interval、timeout 优先。
const original = vi.waitFor.bind(vi);
vi.waitFor = ((callback: Parameters<typeof vi.waitFor>[0], options?: Parameters<typeof vi.waitFor>[1]) =>
  original(callback, { interval: 5, ...(typeof options === 'number' ? { timeout: options } : options) })) as typeof vi.waitFor;
