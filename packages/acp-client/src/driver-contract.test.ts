import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AgentDriver, NormalizedDriverEvent } from '@dockmux/shared';
import { normalizeAcpxEvent, type NormalizedDriverEvent as ReExportedEvent } from './index.js';
import type { AcpxAdapter } from './index.js';

describe('driver contract alignment', () => {
  it('re-exports the canonical NormalizedDriverEvent type from @dockmux/shared', () => {
    expectTypeOf<ReExportedEvent>().toEqualTypeOf<NormalizedDriverEvent>();
    const event = normalizeAcpxEvent('not json');
    const canonical: NormalizedDriverEvent | undefined = event;
    expect(canonical?.type).toBe('raw_terminal');
  });

  it('AcpxAdapter satisfies the shared AgentDriver interface', () => {
    expectTypeOf<AcpxAdapter>().toMatchTypeOf<AgentDriver>();
  });
});
