import { describe, expect, it } from 'vitest';
import type { WorkItem, WorkReviewVerdict } from '@dutydeck/shared';
import { reviewStatusLabel } from './workbench.js';

const makeItem = (opts: {
  status?: WorkItem['status'];
  reviewPolicy?: boolean;
  review?: Partial<WorkReviewVerdict>;
  text?: string;
  outputStepId?: string;
  title?: string;
} = {}): WorkItem => {
  const outputId = opts.outputStepId ?? 'leader_review';
  return {
    id: 'work_1', parentSessionId: 'ses_1', title: '任务', goal: '目标', revision: 1,
    status: opts.status ?? 'completed',
    plan: {
      title: '计划', outputStepId: outputId,
      steps: [
        { id: 'impl', title: '实现', kind: 'agent', agentId: 'worker', instruction: '', dependsOn: [] },
        {
          id: outputId, title: opts.title ?? 'Leader 验收', kind: 'agent', agentId: 'leader', instruction: '', dependsOn: ['impl'],
          ...(opts.reviewPolicy ? { reviewPolicy: { maxReworkRounds: 2, allowedTargetStepIds: ['impl'] } } : {})
        }
      ]
    },
    steps: [
      { id: 'impl', status: 'completed', attempts: [] },
      {
        id: outputId, status: 'completed',
        attempts: opts.review !== undefined ? [{ id: 'att_1', number: 1, status: 'completed', createdAt: '', updatedAt: '', review: opts.review as WorkReviewVerdict }] : []
      }
    ],
    output: opts.text !== undefined ? { text: opts.text, digest: 'd1', stepId: outputId } : undefined,
    delivery: { status: 'not_requested', attempts: 0 }, createdAt: '', updatedAt: ''
  };
};

describe('reviewStatusLabel', () => {
  describe('新 reviewPolicy 结构化判定', () => {
    it('新 policy 下 valid accept 返回 undefined（支持任意自然语言 feedback，不要求特定中文前缀）', () => {
      const item = makeItem({
        reviewPolicy: true,
        review: { decision: 'accept', reviewed: [{ stepId: 'impl', attemptId: 'att_impl_1', digest: 'a'.repeat(64) }], feedback: '代码与测试均已核对，LGTM 满足上线标准。' },
        text: '代码与测试均已核对，LGTM 满足上线标准。'
      });
      expect(reviewStatusLabel(item)).toBeUndefined();
    });

    it('新 policy 下缺 verdict 或 decision 非 accept 时显示验收待核对', () => {
      expect(reviewStatusLabel(makeItem({ reviewPolicy: true }))).toBe('验收待核对');
      expect(reviewStatusLabel(makeItem({
        reviewPolicy: true,
        review: { decision: 'rework', reviewed: [{ stepId: 'impl', attemptId: 'att_impl_1', digest: 'a'.repeat(64) }], targetStepId: 'impl', feedback: '缺少边界测试' }
      }))).toBe('验收待核对');
    });

    it.each(['running', 'blocked'] as const)('非 completed 状态 (%s) 统一返回 undefined', status => {
      expect(reviewStatusLabel(makeItem({ status, reviewPolicy: true, review: { decision: 'accept' } }))).toBeUndefined();
    });
  });

  describe('无 policy 历史记录正则行为', () => {
    it('旧通过返回 undefined', () => {
      expect(reviewStatusLabel(makeItem({ text: '验收结论：通过\n全部核对完毕' }))).toBeUndefined();
      expect(reviewStatusLabel(makeItem({ text: '一些说明\n验收结论：通过\n细节...' }))).toBeUndefined();
    });

    it('旧需返修与缺少信息返回对应标签', () => {
      expect(reviewStatusLabel(makeItem({ text: '验收结论：需返修\n缺集成单测' }))).toBe('验收需返修');
      expect(reviewStatusLabel(makeItem({ text: '验收结论：缺少信息\n请确认环境' }))).toBe('验收缺少信息');
    });

    it('无法识别的文本返回验收待核对', () => {
      expect(reviewStatusLabel(makeItem({ text: '普通总结文本，没有前缀格式' }))).toBe('验收待核对');
    });

    it('非 leader_review 步骤返回 undefined', () => {
      expect(reviewStatusLabel(makeItem({ text: '验收结论：需返修', outputStepId: 'report', title: '报告汇总' }))).toBeUndefined();
    });
  });
});
