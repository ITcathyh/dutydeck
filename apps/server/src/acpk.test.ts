import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { acpkPassThroughArgs, runAcpk } from './acpk.js';

describe('acpk pass-through', () => {
  it('preserves every argument after dutydeck acpk', () => {
    expect(acpkPassThroughArgs(['node', 'dutydeck', 'acpk', 'agents', 'list', '--json', '--scope=x'])).toEqual(['agents', 'list', '--json', '--scope=x']);
    expect(acpkPassThroughArgs(['node', 'dutydeck', '--help'])).toBeUndefined();
  });

  it('spawns acpk without a shell and returns its exit code', async () => {
    const child = new EventEmitter() as any;
    const spawnProcess = vi.fn(() => child);
    const result = runAcpk(['run', '--raw', 'a b'], spawnProcess as any);
    child.emit('exit', 7, null);
    await expect(result).resolves.toBe(7);
    expect(spawnProcess).toHaveBeenCalledWith('acpk', ['run', '--raw', 'a b'], expect.objectContaining({ stdio: 'inherit' }));
  });
});
