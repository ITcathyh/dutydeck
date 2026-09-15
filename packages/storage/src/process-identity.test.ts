import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  currentProcessIdentity,
  observeProcess,
  canonicalizeCDate,
  canonicalizeUuid,
  type ProcessIdentity,
} from './process-identity.js';

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});

const originalPlatform = process.platform;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

describe('Linux process identity (regression)', () => {
  it('treats a failed OS process identity read as unknown', () => {
    if (process.platform !== 'linux') return;
    const identity = currentProcessIdentity();
    const read = vi.mocked(readFileSync).getMockImplementation()!;
    vi.mocked(readFileSync).mockImplementation(((path: unknown, ...args: any[]) => {
      if (path === `/proc/${identity.pid}/stat`) throw Object.assign(new Error('identity access denied'), { code: 'EACCES' });
      return (read as any)(path, ...args);
    }) as typeof readFileSync);
    expect(observeProcess(identity)).toBe('unknown');
  });
});

describe('Darwin canonicalization and validators', () => {
  it('canonicalizes UUIDs and rejects nil or malformed UUIDs', () => {
    expect(canonicalizeUuid('4B7D2678-831C-5A2C-9C5F-81D67B0F1C36')).toBe('4b7d2678-831c-5a2c-9c5f-81d67b0f1c36');
    expect(canonicalizeUuid('  4b7d2678-831c-5a2c-9c5f-81d67b0f1c36  ')).toBe('4b7d2678-831c-5a2c-9c5f-81d67b0f1c36');
    // nil UUID
    expect(canonicalizeUuid('00000000-0000-0000-0000-000000000000')).toBeNull();
    // multiline
    expect(canonicalizeUuid('4b7d2678-831c-5a2c-9c5f-81d67b0f1c36\n4b7d2678-831c-5a2c-9c5f-81d67b0f1c37')).toBeNull();
    // malformed
    expect(canonicalizeUuid('not-a-uuid')).toBeNull();
    expect(canonicalizeUuid('')).toBeNull();
  });

  it('canonicalizes C locale dates and unifies single-digit day spaces', () => {
    const singleSpace = 'Mon Sep 7 09:05:00 2026';
    const doubleSpace = 'Mon Sep  7 09:05:00 2026';
    const padded = '  Mon Sep  7 09:05:00 2026  ';
    expect(canonicalizeCDate(singleSpace)).toBe('Mon Sep  7 09:05:00 2026');
    expect(canonicalizeCDate(doubleSpace)).toBe('Mon Sep  7 09:05:00 2026');
    expect(canonicalizeCDate(padded)).toBe('Mon Sep  7 09:05:00 2026');

    // Two-digit day
    expect(canonicalizeCDate('Mon Sep 14 21:13:05 2026')).toBe('Mon Sep 14 21:13:05 2026');
  });

  it('rejects invalid C locale dates, leap year mismatches, wrong weekdays, and multiline/truncated dates', () => {
    // Leap year checks
    expect(canonicalizeCDate('Thu Feb 29 12:00:00 2024')).toBe('Thu Feb 29 12:00:00 2024'); // 2024 is leap
    expect(canonicalizeCDate('Fri Feb 29 12:00:00 2025')).toBeNull(); // 2025 is not leap
    expect(canonicalizeCDate('Tue Feb 30 12:00:00 2026')).toBeNull(); // Feb 30 does not exist

    // Month out of range / invalid month
    expect(canonicalizeCDate('Mon Foo 14 21:13:05 2026')).toBeNull();
    expect(canonicalizeCDate('Wed Sep 31 12:00:00 2026')).toBeNull(); // Sep has 30 days

    // Weekday mismatch (2026-09-14 is Mon, not Tue)
    expect(canonicalizeCDate('Tue Sep 14 21:13:05 2026')).toBeNull();

    // Time out of range
    expect(canonicalizeCDate('Mon Sep 14 24:00:00 2026')).toBeNull();
    expect(canonicalizeCDate('Mon Sep 14 21:60:00 2026')).toBeNull();
    expect(canonicalizeCDate('Mon Sep 14 21:13:99 2026')).toBeNull();

    // Multiline / truncated
    expect(canonicalizeCDate('Mon Sep 14 21:13:05 2026\nMon Sep 14 21:13:06 2026')).toBeNull();
    expect(canonicalizeCDate('Mon Sep 14 21:13:05')).toBeNull();
    expect(canonicalizeCDate('')).toBeNull();
  });
});

describe('Darwin currentProcessIdentity', () => {
  const sampleHardwareUuid = '4B7D2678-831C-5A2C-9C5F-81D67B0F1C36';
  const canonicalHardwareUuid = sampleHardwareUuid.toLowerCase();
  const expectedHostHash = createHash('sha256').update(canonicalHardwareUuid).digest('hex');
  const sampleBootUuid = 'A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D'.toLowerCase();
  const sampleLstart = 'Mon Sep 14 21:13:05 2026';

  function mockDarwinTools(overrides: {
    ioregOutput?: string;
    sysctlOutput?: string;
    psOutput?: string;
    ioregError?: Error;
    sysctlError?: Error;
    psError?: Error;
  } = {}) {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    return vi.mocked(execFileSync).mockImplementation(((file: string, args?: any, options?: any) => {
      // Assert absolute paths without shell
      expect(['/usr/sbin/ioreg', '/usr/sbin/sysctl', '/bin/ps']).toContain(file);
      // Assert stdio and timeout
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      expect(options.timeout).toBe(5000);
      // Assert locale / TZ isolation
      expect(options.env.LC_ALL).toBe('C');
      expect(options.env.LANG).toBe('C');
      expect(options.env.TZ).toBe('UTC');

      if (file === '/usr/sbin/ioreg') {
        expect(args).toEqual(['-rd1', '-c', 'IOPlatformExpertDevice']);
        if (overrides.ioregError) throw overrides.ioregError;
        return (overrides.ioregOutput ?? `{\n  "IOPlatformUUID" = "${sampleHardwareUuid}"\n}`) as any;
      }
      if (file === '/usr/sbin/sysctl') {
        expect(args).toEqual(['-n', 'kern.bootsessionuuid']);
        if (overrides.sysctlError) throw overrides.sysctlError;
        return (overrides.sysctlOutput ?? `${sampleBootUuid}\n`) as any;
      }
      if (file === '/bin/ps') {
        expect(args[0]).toBe('-p');
        expect(args[2]).toBe('-o');
        expect(args[3]).toBe('lstart=');
        if (overrides.psError) throw overrides.psError;
        return (overrides.psOutput ?? `${sampleLstart}\n`) as any;
      }
      throw new Error(`Unexpected command: ${file}`);
    }) as any);
  }

  it('reads host, boot, namespace, pid, and start with strict command arguments and env isolation', () => {
    const originalEnv = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, TZ: process.env.TZ };
    process.env.LC_ALL = 'zh_CN.UTF-8';
    process.env.LANG = 'fr_FR.UTF-8';
    process.env.TZ = 'Asia/Shanghai';

    try {
      mockDarwinTools();
      const identity = currentProcessIdentity();
      expect(identity).toEqual({
        host: `darwin:host-v1:${expectedHostHash}`,
        boot: sampleBootUuid,
        namespace: 'darwin:host-v1',
        pid: process.pid,
        start: `darwin:lstart-v1:${sampleLstart}`,
      });
    } finally {
      if (originalEnv.LC_ALL !== undefined) process.env.LC_ALL = originalEnv.LC_ALL; else delete process.env.LC_ALL;
      if (originalEnv.LANG !== undefined) process.env.LANG = originalEnv.LANG; else delete process.env.LANG;
      if (originalEnv.TZ !== undefined) process.env.TZ = originalEnv.TZ; else delete process.env.TZ;
    }
  });

  it('rejects ioreg failure, empty, multiple, nil, or truncated UUID with DATABASE_IDENTITY_UNAVAILABLE', () => {
    mockDarwinTools({ ioregError: new Error('ioreg command failed') });
    expect(() => currentProcessIdentity()).toThrow('DATABASE_IDENTITY_UNAVAILABLE');

    mockDarwinTools({ ioregOutput: '{\n  "NoUUIDHere" = "none"\n}' });
    expect(() => currentProcessIdentity()).toThrow('DATABASE_IDENTITY_UNAVAILABLE');

    mockDarwinTools({
      ioregOutput: `{\n  "IOPlatformUUID" = "${sampleHardwareUuid}"\n  "IOPlatformUUID" = "5B7D2678-831C-5A2C-9C5F-81D67B0F1C37"\n}`,
    });
    expect(() => currentProcessIdentity()).toThrow('DATABASE_IDENTITY_UNAVAILABLE');

    mockDarwinTools({
      ioregOutput: '{\n  "IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"\n}',
    });
    expect(() => currentProcessIdentity()).toThrow('DATABASE_IDENTITY_UNAVAILABLE');

    mockDarwinTools({
      ioregOutput: '{\n  "IOPlatformUUID" = "not-a-valid-uuid"\n}',
    });
    expect(() => currentProcessIdentity()).toThrow('DATABASE_IDENTITY_UNAVAILABLE');
  });

  it('rejects sysctl failure, multiline, or malformed boot UUID with DATABASE_IDENTITY_UNAVAILABLE', () => {
    mockDarwinTools({ sysctlError: new Error('sysctl failed') });
    expect(() => currentProcessIdentity()).toThrow('DATABASE_IDENTITY_UNAVAILABLE');

    mockDarwinTools({ sysctlOutput: `${sampleBootUuid}\nsecond-line\n` });
    expect(() => currentProcessIdentity()).toThrow('DATABASE_IDENTITY_UNAVAILABLE');

    mockDarwinTools({ sysctlOutput: '00000000-0000-0000-0000-000000000000\n' });
    expect(() => currentProcessIdentity()).toThrow('DATABASE_IDENTITY_UNAVAILABLE');

    mockDarwinTools({ sysctlOutput: 'invalid-boot-uuid\n' });
    expect(() => currentProcessIdentity()).toThrow('DATABASE_IDENTITY_UNAVAILABLE');
  });

  it('rejects ps failure, multiline, or malformed date with DATABASE_IDENTITY_UNAVAILABLE', () => {
    mockDarwinTools({ psError: new Error('ps failed') });
    expect(() => currentProcessIdentity()).toThrow('DATABASE_IDENTITY_UNAVAILABLE');

    mockDarwinTools({ psOutput: `${sampleLstart}\n${sampleLstart}\n` });
    expect(() => currentProcessIdentity()).toThrow('DATABASE_IDENTITY_UNAVAILABLE');

    mockDarwinTools({ psOutput: 'InvalidDateString\n' });
    expect(() => currentProcessIdentity()).toThrow('DATABASE_IDENTITY_UNAVAILABLE');
  });

  it('throws DATABASE_IDENTITY_UNSUPPORTED on non-Linux and non-Darwin platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(() => currentProcessIdentity()).toThrow('DATABASE_IDENTITY_UNSUPPORTED');
  });
});

describe('Darwin observeProcess', () => {
  const validHost = `darwin:host-v1:${createHash('sha256').update('4b7d2678-831c-5a2c-9c5f-81d67b0f1c36').digest('hex')}`;
  const validBoot = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
  const validStart = 'darwin:lstart-v1:Mon Sep 14 21:13:05 2026';

  const baseIdentity: ProcessIdentity = {
    host: validHost,
    boot: validBoot,
    namespace: 'darwin:host-v1',
    pid: 12345,
    start: validStart,
  };

  function setupDarwinHost(overrides: {
    ioregOutput?: string;
    sysctlOutput?: string;
    psOutput?: string;
    psError?: Error;
    killImpl?: (pid: number, signal?: string | number) => true;
  } = {}) {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.mocked(execFileSync).mockImplementation(((file: string, args?: any, options?: any) => {
      // Both ps entries must check locale params
      if (file === '/bin/ps') {
        expect(options.env.LC_ALL).toBe('C');
        expect(options.env.LANG).toBe('C');
        expect(options.env.TZ).toBe('UTC');
        if (overrides.psError) throw overrides.psError;
        return (overrides.psOutput ?? 'Mon Sep 14 21:13:05 2026\n') as any;
      }
      if (file === '/usr/sbin/ioreg') {
        return (overrides.ioregOutput ?? '{\n  "IOPlatformUUID" = "4B7D2678-831C-5A2C-9C5F-81D67B0F1C36"\n}') as any;
      }
      if (file === '/usr/sbin/sysctl') {
        return (overrides.sysctlOutput ?? `${validBoot}\n`) as any;
      }
      throw new Error(`Unexpected command: ${file}`);
    }) as any);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      // Strict rule: signal 0 only, no TERM/KILL signals
      expect(signal).toBe(0);
      if (overrides.killImpl) return overrides.killImpl(pid, signal);
      return true;
    });

    return { killSpy };
  }

  it('rejects malformed identity fields before comparing host or boot', () => {
    setupDarwinHost();

    // Invalid PID
    expect(observeProcess({ ...baseIdentity, pid: 0 })).toBe('unknown');
    expect(observeProcess({ ...baseIdentity, pid: -1 })).toBe('unknown');
    expect(observeProcess({ ...baseIdentity, pid: NaN })).toBe('unknown');
    expect(observeProcess({ ...baseIdentity, pid: 1.5 })).toBe('unknown');

    // Wrong namespace
    expect(observeProcess({ ...baseIdentity, namespace: 'linux:ns-v1' })).toBe('unknown');

    // Malformed host
    expect(observeProcess({ ...baseIdentity, host: 'not-darwin-host' })).toBe('unknown');
    expect(observeProcess({ ...baseIdentity, host: 'darwin:host-v1:short' })).toBe('unknown');

    // Malformed boot UUID (must be rejected before host/boot comparison)
    expect(observeProcess({ ...baseIdentity, boot: 'malformed-boot' })).toBe('unknown');
    expect(observeProcess({ ...baseIdentity, boot: '00000000-0000-0000-0000-000000000000' })).toBe('unknown');

    // Malformed start format / date
    expect(observeProcess({ ...baseIdentity, start: 'Mon Sep 14 21:13:05 2026' })).toBe('unknown'); // missing prefix
    expect(observeProcess({ ...baseIdentity, start: 'darwin:lstart-v1:invalid-date' })).toBe('unknown');
    expect(observeProcess({ ...baseIdentity, start: 'darwin:lstart-v1:Tue Sep 14 21:13:05 2026' })).toBe('unknown'); // wrong weekday
    expect(observeProcess({ ...baseIdentity, start: 'darwin:lstart-v1:Mon Sep 14 21:13:05 2026\nextra' })).toBe('unknown');
  });

  it('foreign host returns unknown even if boot also differs', () => {
    setupDarwinHost();
    const foreignIdentity: ProcessIdentity = {
      ...baseIdentity,
      host: `darwin:host-v1:${createHash('sha256').update('5b7d2678-831c-5a2c-9c5f-81d67b0f1c37').digest('hex')}`,
      boot: 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e', // different boot
    };
    expect(observeProcess(foreignIdentity)).toBe('unknown');
  });

  it('same host with different boot returns dead', () => {
    setupDarwinHost();
    const differentBootIdentity: ProcessIdentity = {
      ...baseIdentity,
      boot: 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e',
    };
    expect(observeProcess(differentBootIdentity)).toBe('dead');
  });

  it('equivalent boot representations (uppercase, surrounding whitespace/newlines) do not cause false dead and continue verifying target process', () => {
    let psCalls = 0;
    setupDarwinHost();
    vi.mocked(execFileSync).mockImplementation(((file: string, args?: any, options?: any) => {
      if (file === '/bin/ps') {
        psCalls++;
        return 'Mon Sep 14 21:13:05 2026\n' as any;
      }
      if (file === '/usr/sbin/ioreg') {
        return '{\n  "IOPlatformUUID" = "4B7D2678-831C-5A2C-9C5F-81D67B0F1C36"\n}' as any;
      }
      if (file === '/usr/sbin/sysctl') {
        return `${validBoot}\n` as any;
      }
      throw new Error(`Unexpected command: ${file}`);
    }) as any);

    const equivalentBoots = [
      ['canonical', validBoot],
      ['uppercase', validBoot.toUpperCase()],
      ['padded', `  ${validBoot}  `],
      ['surrounding_newline', `\n${validBoot}\n`],
    ];

    for (const [, bootValue] of equivalentBoots) {
      psCalls = 0;
      expect(observeProcess({ ...baseIdentity, boot: bootValue })).toBe('unknown');
      expect(psCalls).toBe(1);
    }

    // Truly different valid boot returns dead and does NOT call ps
    psCalls = 0;
    expect(observeProcess({ ...baseIdentity, boot: 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e' })).toBe('dead');
    expect(psCalls).toBe(0);

    // Malformed boot returns unknown and does NOT call ps
    psCalls = 0;
    expect(observeProcess({ ...baseIdentity, boot: 'malformed-boot' })).toBe('unknown');
    expect(psCalls).toBe(0);

    // Foreign host returns unknown and does NOT call ps even if boot differs
    psCalls = 0;
    expect(observeProcess({
      ...baseIdentity,
      host: `darwin:host-v1:${createHash('sha256').update('5b7d2678-831c-5a2c-9c5f-81d67b0f1c37').digest('hex')}`,
      boot: 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e',
    })).toBe('unknown');
    expect(psCalls).toBe(0);
  });

  it('same host and boot with different start returns dead', () => {
    setupDarwinHost({
      psOutput: 'Mon Sep 14 21:13:06 2026\n', // 1 second later
    });
    expect(observeProcess(baseIdentity)).toBe('dead');
  });

  it('same host and boot with same start returns unknown (conservative same-second reuse)', () => {
    setupDarwinHost({
      psOutput: 'Mon Sep 14 21:13:05 2026\n',
    });
    // Strict requirement: returns unknown, never alive
    expect(observeProcess(baseIdentity)).toBe('unknown');
  });

  it('single-digit day whitespace variations do not cause false dead', () => {
    const singleSpaceIdentity: ProcessIdentity = {
      ...baseIdentity,
      start: 'darwin:lstart-v1:Mon Sep 7 09:05:00 2026',
    };
    setupDarwinHost({
      psOutput: 'Mon Sep  7 09:05:00 2026\n',
    });
    expect(observeProcess(singleSpaceIdentity)).toBe('unknown');
  });

  it('when ps fails, crashes, times out, or returns malformed output, only ESRCH from kill(pid, 0) proves dead', () => {
    const { killSpy } = setupDarwinHost({
      psError: Object.assign(new Error('ps: no such process'), { code: 1 }),
      killImpl: () => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      },
    });
    expect(observeProcess(baseIdentity)).toBe('dead');
    expect(killSpy).toHaveBeenCalledWith(baseIdentity.pid, 0);

    setupDarwinHost({
      psError: Object.assign(new Error('ps timeout'), { code: 'ETIMEDOUT' }),
      killImpl: () => true,
    });
    expect(observeProcess(baseIdentity)).toBe('unknown');

    setupDarwinHost({
      psError: Object.assign(new Error('ps failed'), { code: 1 }),
      killImpl: () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
    });
    expect(observeProcess(baseIdentity)).toBe('unknown');

    setupDarwinHost({
      psError: Object.assign(new Error('ps failed'), { code: 1 }),
      killImpl: () => {
        throw Object.assign(new Error('generic error'), { code: 'EIO' });
      },
    });
    expect(observeProcess(baseIdentity)).toBe('unknown');

    setupDarwinHost({
      psOutput: 'malformed ps output\n',
      killImpl: () => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      },
    });
    expect(observeProcess(baseIdentity)).toBe('dead');
  });

  it('returns unknown if local identity cannot be read', () => {
    setupDarwinHost({
      ioregOutput: 'empty',
    });
    expect(observeProcess(baseIdentity)).toBe('unknown');
  });
});
