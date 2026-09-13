import { describe, expect, it } from 'vitest';
import { RECOVERY_TRACKING_NOTE, replayedRecoveryNote } from './recovery-notes.js';

describe('恢复文案', () => {
  it('replayed 注记为非空中文字文案，覆盖重启期间排队/中断与已恢复两层语义', () => {
    const note = replayedRecoveryNote();
    expect(note.length).toBeGreaterThan(0);
    expect(note).toContain('重启');
    expect(note).toMatch(/排队|中断/);
    expect(note).toContain('恢复');
  });

  it('replayed 注记不承诺重放审批或文件验收', () => {
    const note = replayedRecoveryNote();
    expect(note).not.toContain('重新审批');
    expect(note).not.toContain('重新验收');
  });

  it('两次调用措辞稳定，供两处复用不漂移', () => {
    expect(replayedRecoveryNote()).toBe(replayedRecoveryNote());
  });

  it('reconciler 恢复卡统一文案为现有原文（替换不改卡面）', () => {
    expect(RECOVERY_TRACKING_NOTE).toBe('Dutydeck 已恢复任务状态，正在继续跟踪执行进度。');
  });

  it('两条文案各自独立、不相同', () => {
    expect(replayedRecoveryNote()).not.toBe(RECOVERY_TRACKING_NOTE);
  });
});
