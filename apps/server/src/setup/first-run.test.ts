import { describe, expect, it, vi } from 'vitest';
import { maybePrintFirstRunGuidance } from './first-run.js';

describe('first-run guidance', () => {
  const defaults = {
    address: 'http://127.0.0.1:4310',
    databaseUrl: '/tmp/first-run-test.db',
    isTTY: true,
    env: {},
    hasBotConfiguration: vi.fn(async () => false),
    cliOnPath: () => true
  };

  it('prints setup, doctor and the actual Web address whenever no bot is configured', async () => {
    const write = vi.fn();
    const options = { ...defaults, address: 'http://127.0.0.1:51234', write };
    await maybePrintFirstRunGuidance(options);
    await maybePrintFirstRunGuidance(options);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]![0]).toContain('dutydeck setup');
    expect(write.mock.calls[0]![0]).toContain('dutydeck doctor');
    expect(write.mock.calls[0]![0]).toContain('http://127.0.0.1:51234');
    expect(write.mock.calls[0]![0]).not.toContain('pnpm setup');
  });

  it('does not print when a bot exists', async () => {
    const write = vi.fn();
    await maybePrintFirstRunGuidance({ ...defaults, write, hasBotConfiguration: async () => true });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ['non-TTY', { isTTY: false }],
    ['JSON', { json: true }],
    ['daemon child', { env: { DUTYDECK_DAEMONIZED: '1' } }]
  ])('does not read configuration or print for %s', async (_name, override) => {
    const write = vi.fn();
    const hasBotConfiguration = vi.fn(async () => false);
    await maybePrintFirstRunGuidance({ ...defaults, ...override, write, hasBotConfiguration });
    expect(hasBotConfiguration).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('explains how to repair PATH without assuming one installation method', async () => {
    const write = vi.fn();
    await maybePrintFirstRunGuidance({ ...defaults, write, cliOnPath: () => false });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0]).toContain('not on PATH');
    expect(write.mock.calls[0]![0]).toContain('pnpm setup');
    expect(write.mock.calls[0]![0]).toContain('pnpm dlx @byted/dutydeck');
    expect(write.mock.calls[0]![0]).toContain('npx @byted/dutydeck');
  });

  it('does not block startup when configuration reading or output writing fails', async () => {
    await expect(maybePrintFirstRunGuidance({
      ...defaults,
      hasBotConfiguration: async () => { throw new Error('database unavailable'); }
    })).resolves.toBeUndefined();
    await expect(maybePrintFirstRunGuidance({
      ...defaults,
      write: () => { throw new Error('output unavailable'); }
    })).resolves.toBeUndefined();
  });
});
