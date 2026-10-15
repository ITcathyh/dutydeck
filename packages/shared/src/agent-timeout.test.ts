import { describe, expect, it } from 'vitest';
import { agentConfigSchema } from './index.js';

const agent = { id: 'timer-fixture', name: 'Timer fixture', command: 'unused' };
describe('Agent timeout seconds map to safe integer milliseconds', () => {
  it.each([0.0001, 0.0005, 0.0011, 2_147_483.648, NaN, Infinity])('rejects %s seconds', timeout => {
    expect(agentConfigSchema.safeParse({ ...agent, timeout }).success).toBe(false);
  });
  it.each([0.001, 0.1, 1.001, 2.003, 600, 2_147_483.647])('preserves valid %s seconds despite floating point multiplication', timeout => {
    expect(agentConfigSchema.parse({ ...agent, timeout }).timeout).toBe(timeout);
  });
});
