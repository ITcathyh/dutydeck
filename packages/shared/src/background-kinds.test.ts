import { expect, it } from 'vitest';
import { backgroundKindCases } from '../../../tests/support/background-kind-cases.js';
import { backgroundKindFor, backgroundKinds } from './background-kinds.js';

it('matches the original policies for every persisted background source', () => {
  expect(Object.keys(backgroundKinds).sort()).toEqual(backgroundKindCases.map(row => row.source).sort());
  for (const { source, ...policy } of backgroundKindCases) expect(backgroundKindFor(source)).toEqual(policy);
});

it('leaves unrelated and missing sources to their existing handlers', () => {
  for (const source of [undefined, null, '', 'work_item', 'web', 'constructor', '__proto__']) {
    expect(backgroundKindFor(source)).toBeUndefined();
  }
});
