import { afterEach, expect, it } from 'vitest';
import { setInstance } from './instance';
import { taskReadingScopeKey, viewPreferenceKey } from './view-preferences';

afterEach(() => setInstance(undefined));

it('isolates the default instance from legal main and local peer names for preferences and reading', () => {
  const preferenceKeys = new Set<string>();
  const readingKeys = new Set<string>();
  for (const instance of [undefined, 'main', 'local']) {
    setInstance(instance);
    preferenceKeys.add(viewPreferenceKey('task-views'));
    readingKeys.add(taskReadingScopeKey('same-task'));
  }
  expect(preferenceKeys.size).toBe(3);
  expect(readingKeys.size).toBe(3);
});
