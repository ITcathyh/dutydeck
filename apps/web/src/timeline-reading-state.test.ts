import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => { sessionStorage.clear(); vi.resetModules(); });

describe('timeline reading preferences', () => {
  it('persists only small reading metadata and isolates instances', async () => {
    const { getTimelineReadingState, saveTimelineReadingState } = await import('./timeline-reading-state');
    const state = getTimelineReadingState('instance-one:task');
    Object.assign(state, { following: false, scrollTop: 1450, anchor: { id: 'turn-42', eventId: 'event-43', offset: 50, screenOffset: -20 } });
    state.disclosures.set('tool:43', true);
    state.heights.set('turn-42', 640);
    saveTimelineReadingState();
    expect(getTimelineReadingState('instance-two:task').following).toBe(true);
    vi.resetModules();
    const restored = (await import('./timeline-reading-state')).getTimelineReadingState('instance-one:task');
    expect(restored).toMatchObject({ following: false, scrollTop: 1450, anchor: state.anchor });
    expect(restored.disclosures.get('tool:43')).toBe(true);
    expect(restored.heights.size).toBe(0);
  });

  it('bounds stored scopes and disclosure records', async () => {
    const { getTimelineReadingState, saveTimelineReadingState } = await import('./timeline-reading-state');
    for (let index = 0; index < 50; index++) getTimelineReadingState(`task-${index}`);
    const state = getTimelineReadingState('task-49');
    for (let index = 0; index < 500; index++) state.disclosures.set(`tool:${index}`, true);
    saveTimelineReadingState();
    const saved = JSON.parse(sessionStorage.getItem('dutydeck:timeline-reading:v1')!);
    expect(saved.length).toBe(40);
    expect(saved.at(-1)[1].disclosures.length).toBe(400);
  });

  it('keeps navigation working when browser storage is unavailable', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
    try {
      const { getTimelineReadingState, saveTimelineReadingState } = await import('./timeline-reading-state');
      getTimelineReadingState('task').following = false;
      expect(() => saveTimelineReadingState()).not.toThrow();
      expect(getTimelineReadingState('task').following).toBe(false);
    } finally { spy.mockRestore(); }
  });
});
