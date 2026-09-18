import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw,
  Check,
  X,
  Plus,
  Play,
  Pause,
  Clock,
  Shield,
  CheckCircle2,
  HelpCircle,
  RotateCw,
  Bell,
  BellOff,
  Edit3
} from 'lucide-react';
import {
  collaborationApi,
  ApiError,
  type CollaborationOverview,
  type CollaborationSettings,
  type CollaborationDecision,
  type CollaborationReplayResponse,
  type CollaborationParticipation,
  type ScheduleTrigger,
  type CollaborationMandateDetail,
  type CreateCollaborationFollowupInput,
  type CreateCollaborationMandateInput
} from '../api';
import {
  Badge,
  Banner,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Tabs,
  Textarea
} from './primitives';

export type CollaborationPanelProps = {
  appId: string;
  chatId: string;
  groupName?: string;
  botName?: string;
  className?: string;
};

type ActiveTab = 'settings' | 'followups' | 'mandates' | 'actions' | 'decisions';

const participationLabels: Record<CollaborationParticipation, { title: string; desc: string }> = {
  off: { title: '保持原行为 (off)', desc: '沿用原群参与规则' },
  observe: { title: '只观察 (observe)', desc: '记录群聊事件上下文与候选，但不主动发言' },
  selective: { title: '按需参与 (selective)', desc: '有充分根据且获得授权时，主动提供协作与反馈' }
};

const isRevisionConflict = (error: unknown) =>
  error instanceof ApiError &&
  (error.status === 409 || error.code === 'COLLABORATION_REVISION_CONFLICT');

/**
 * 排除内部 command 及执行动作；只包含真实的外部协作动作
 */
export function isExternalCollaborationAction(kind: string): boolean {
  if (kind.startsWith('command:') || kind === 'agent_execution' || kind === 'schedule_agent') {
    return false;
  }
  return (
    kind === 'participation.reply' ||
    kind === 'schedule_delivery' ||
    kind.startsWith('extension:')
  );
}

/**
 * datetime-local 如果没有秒，自动补充 :00
 */
export function normalizeLocalDateTime(dt: string): string {
  const trimmed = dt.trim();
  if (!trimmed) return trimmed;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) {
    return `${trimmed}:00`;
  }
  return trimmed;
}

function generateStableId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type ScheduleEditRequest = { id: string; expectedRevision: number; trigger: ScheduleTrigger; timezone: string };

type MandatePatch = {
  expectedRevision: number;
  status?: 'active' | 'paused' | 'cancelled' | 'completed';
  deliveryPaused?: boolean;
  trigger?: ScheduleTrigger;
  timezone?: string;
};

/**
 * 内部实现组件，由外层 CollaborationPanel 按 `${appId}:${chatId}` 的 key 强制重建，
 * 保证切换群 / 切换 Bot 时 query、草稿、对话框、回放结果全部隔离。
 */
function CollaborationPanelInner({ appId, chatId, groupName, botName, className }: CollaborationPanelProps) {
  const queryClient = useQueryClient();
  const queryKey = ['collaboration-overview', appId, chatId];

  const overviewQuery = useQuery<CollaborationOverview>({
    queryKey,
    queryFn: () => collaborationApi.getOverview(appId, chatId),
    retry: false
  });

  const [activeTab, setActiveTab] = useState<ActiveTab>('settings');

  // ---- Bootstrap 重新补读上下文 ----
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const bootstrapMutation = useMutation({
    mutationFn: () => collaborationApi.bootstrap(appId, chatId),
    onSuccess: async () => {
      setBootstrapError(null);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: error => setBootstrapError(error instanceof Error ? error.message : '初始化失败')
  });

  // ---- 协作设置草稿与保存（独立 expectedRevision，409 保留草稿）----
  const [settingsDraft, setSettingsDraft] = useState<CollaborationSettings | null>(null);
  const [settingsConflict, setSettingsConflict] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSuccess, setSettingsSuccess] = useState(false);

  const currentSettings = overviewQuery.data?.snapshot.settings;
  const draft = settingsDraft ?? currentSettings ?? null;

  const isSettingsDirty = Boolean(
    draft &&
      currentSettings &&
      (draft.participation !== currentSettings.participation ||
        draft.instructions !== currentSettings.instructions ||
        draft.notificationsPaused !== currentSettings.notificationsPaused ||
        draft.maxProactivePerHour !== currentSettings.maxProactivePerHour)
  );

  const saveSettingsMutation = useMutation({
    mutationFn: (payload: CollaborationSettings) =>
      collaborationApi.updateSettings(appId, chatId, {
        expectedRevision: payload.revision,
        participation: payload.participation,
        instructions: payload.instructions,
        notificationsPaused: payload.notificationsPaused,
        maxProactivePerHour: payload.maxProactivePerHour
      }),
    onSuccess: async () => {
      setSettingsDraft(null);
      setSettingsConflict(false);
      setSettingsError(null);
      setSettingsSuccess(true);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: error => {
      if (isRevisionConflict(error)) {
        setSettingsConflict(true);
      } else {
        setSettingsError(error instanceof Error ? error.message : '保存失败');
      }
    }
  });

  // ---- 待办事项：新建 (稳定 ID 与不可变快照重试) ----
  const [createFollowupOpen, setCreateFollowupOpen] = useState(false);
  const [followupStableId, setFollowupStableId] = useState<string>('');
  const followupFrozenPayloadRef = useRef<CreateCollaborationFollowupInput | null>(null);
  const [newFollowupGoal, setNewFollowupGoal] = useState('');
  const [newFollowupProgress, setNewFollowupProgress] = useState('');
  const [newFollowupOwnerId, setNewFollowupOwnerId] = useState('');
  const [newFollowupDueAt, setNewFollowupDueAt] = useState('');
  const [newFollowupSteps, setNewFollowupSteps] = useState<string[]>([]);
  const [newStepInput, setNewStepInput] = useState('');
  const [followupError, setFollowupError] = useState<string | null>(null);

  const resetFollowupForm = () => {
    followupFrozenPayloadRef.current = null;
    createFollowupMutation.reset();
    setFollowupStableId('');
    setNewFollowupGoal('');
    setNewFollowupProgress('');
    setNewFollowupOwnerId('');
    setNewFollowupDueAt('');
    setNewFollowupSteps([]);
    setNewStepInput('');
    setFollowupError(null);
  };

  const openNewFollowupDialog = () => {
    if (!createFollowupOpen) {
      resetFollowupForm();
      setFollowupStableId(generateStableId('followup'));
      setCreateFollowupOpen(true);
    }
  };

  const closeNewFollowupDialog = () => {
    if (createFollowupMutation.isPending) return;
    setCreateFollowupOpen(false);
    resetFollowupForm();
  };

  const createFollowupMutation = useMutation({
    mutationFn: (payload: CreateCollaborationFollowupInput) =>
      collaborationApi.createFollowup(appId, chatId, payload),
    onSuccess: async () => {
      setCreateFollowupOpen(false);
      resetFollowupForm();
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: error => setFollowupError(error instanceof Error ? error.message : '创建失败')
  });

  const submitCreateFollowup = () => {
    // 若已有冻结快照（网络重试阶段），严格使用该不可变快照重试，不重新从 state 组装
    if (followupFrozenPayloadRef.current) {
      createFollowupMutation.mutate(followupFrozenPayloadRef.current);
      return;
    }

    // 首次提交：本地校验（校验失败允许编辑，不冻结）
    const trimmedGoal = newFollowupGoal.trim();
    if (!trimmedGoal) {
      setFollowupError('目标不能为空');
      return;
    }

    const id = followupStableId || generateStableId('followup');
    if (!followupStableId) setFollowupStableId(id);

    const payload: CreateCollaborationFollowupInput = {
      id,
      goal: trimmedGoal,
      progress: newFollowupProgress.trim() || undefined,
      ownerId: newFollowupOwnerId.trim() || undefined,
      dueAt: newFollowupDueAt ? new Date(newFollowupDueAt).toISOString() : undefined,
      steps: newFollowupSteps.map((label, idx) => ({
        id: `step_${id}_${idx + 1}`,
        label,
        status: 'open' as const
      }))
    };

    followupFrozenPayloadRef.current = payload;
    createFollowupMutation.mutate(payload);
  };

  // ---- 待办事项：更新状态 / 步骤 ----
  const updateFollowupMutation = useMutation({
    mutationFn: (variables: {
      id: string;
      expectedRevision: number;
      patch: {
        status?: 'open' | 'completed' | 'cancelled';
        progress?: string;
        steps?: Array<{ id: string; label: string; status: 'open' | 'done' }>;
      };
    }) =>
      collaborationApi.updateFollowup(appId, chatId, variables.id, {
        expectedRevision: variables.expectedRevision,
        ...variables.patch
      }),
    onSuccess: async () => {
      setFollowupError(null);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: error =>
      setFollowupError(
        isRevisionConflict(error)
          ? '事项已被他人更新（版本冲突），请刷新后重试。'
          : error instanceof Error
          ? error.message
          : '更新失败'
      )
  });

  // ---- 待办事项：编辑进展 (Progress) ----
  const [editingProgressId, setEditingProgressId] = useState<string | null>(null);
  const [progressDrafts, setProgressDrafts] = useState<Record<string, { value: string; baseRevision: number }>>({});
  const [progressConflictId, setProgressConflictId] = useState<string | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);

  const startEditProgress = (id: string, initialValue: string, baseRevision: number) => {
    if (saveProgressMutation.isPending) return;
    setEditingProgressId(id);
    setProgressDrafts(prev => ({ ...prev, [id]: prev[id] ?? { value: initialValue, baseRevision } }));
    setProgressConflictId(null);
    setProgressError(null);
  };

  const saveProgressMutation = useMutation({
    mutationFn: ({ id, expectedRevision, progress }: { id: string; expectedRevision: number; progress: string }) =>
      collaborationApi.updateFollowup(appId, chatId, id, {
        expectedRevision,
        progress: progress.trim()
      }),
    onSuccess: async (_data, variables) => {
      setEditingProgressId(null);
      setProgressConflictId(null);
      setProgressError(null);
      setProgressDrafts(prev => {
        const next = { ...prev };
        delete next[variables.id];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error, variables) => {
      if (isRevisionConflict(error)) {
        setProgressConflictId(variables.id);
      } else {
        setProgressError(error instanceof Error ? error.message : '更新进展失败');
      }
    }
  });

  // ---- 委托任务：新建 (稳定 ID、冻结 anchorAt 与不可变快照重试) ----
  const [createMandateOpen, setCreateMandateOpen] = useState(false);
  const [mandateStableId, setMandateStableId] = useState<string>('');
  const [mandateFrozenAnchorAt, setMandateFrozenAnchorAt] = useState<string>('');
  const mandateFrozenPayloadRef = useRef<CreateCollaborationMandateInput | null>(null);
  const [newMandateGoal, setNewMandateGoal] = useState('');
  const [newMandateMode, setNewMandateMode] = useState<'notify' | 'agent'>('agent');
  const [newMandatePrompt, setNewMandatePrompt] = useState('');
  const [newMandateFollowupId, setNewMandateFollowupId] = useState('');
  const [newMandateTriggerType, setNewMandateTriggerType] = useState<'interval' | 'at' | 'cron'>(
    'interval'
  );
  const [newMandateIntervalMinutes, setNewMandateIntervalMinutes] = useState(60);
  const [newMandateAtTime, setNewMandateAtTime] = useState('');
  const [newMandateCronExpr, setNewMandateCronExpr] = useState('0 9 * * *');
  const [newMandateTimezone, setNewMandateTimezone] = useState('Asia/Shanghai');
  const [newMandateCondition, setNewMandateCondition] = useState<
    'always' | 'followup_open' | 'no_progress'
  >('always');
  const [newMandateCatchup, setNewMandateCatchup] = useState<'skip' | 'coalesce'>('skip');
  const [mandateError, setMandateError] = useState<string | null>(null);

  const resetMandateForm = () => {
    mandateFrozenPayloadRef.current = null;
    createMandateMutation.reset();
    setMandateStableId('');
    setMandateFrozenAnchorAt('');
    setNewMandateGoal('');
    setNewMandatePrompt('');
    setNewMandateFollowupId('');
    setNewMandateIntervalMinutes(60);
    setNewMandateAtTime('');
    setNewMandateCronExpr('0 9 * * *');
    setNewMandateTimezone('Asia/Shanghai');
    setNewMandateTriggerType('interval');
    setMandateError(null);
  };

  const openNewMandateDialog = () => {
    if (!createMandateOpen) {
      resetMandateForm();
      setMandateStableId(generateStableId('mandate'));
      setMandateFrozenAnchorAt(new Date().toISOString());
      setCreateMandateOpen(true);
    }
  };

  const closeNewMandateDialog = () => {
    if (createMandateMutation.isPending) return;
    setCreateMandateOpen(false);
    resetMandateForm();
  };

  const buildCreateTrigger = (): ScheduleTrigger => {
    if (newMandateTriggerType === 'interval') {
      const minutes = Math.floor(newMandateIntervalMinutes);
      if (isNaN(minutes) || minutes < 1) {
        throw new Error('执行间隔必须至少为 1 分钟');
      }
      return {
        kind: 'interval',
        everySeconds: minutes * 60,
        anchorAt: mandateFrozenAnchorAt || new Date().toISOString()
      };
    }
    if (newMandateTriggerType === 'at') {
      const normalized = normalizeLocalDateTime(newMandateAtTime);
      if (!normalized || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(normalized)) {
        throw new Error('请选择有效的单次触发时间');
      }
      return { kind: 'at', localDateTime: normalized };
    }
    if (!newMandateCronExpr.trim()) {
      throw new Error('Cron 表达式不能为空');
    }
    return { kind: 'cron', expression: newMandateCronExpr.trim() };
  };

  const createMandateMutation = useMutation({
    mutationFn: (payload: CreateCollaborationMandateInput) =>
      collaborationApi.createMandate(appId, chatId, payload),
    onSuccess: async () => {
      setCreateMandateOpen(false);
      resetMandateForm();
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: error => setMandateError(error instanceof Error ? error.message : '创建失败')
  });

  const submitCreateMandate = () => {
    // 若已有冻结快照，直接重试使用该不可变快照，不重新从 state 组装
    if (mandateFrozenPayloadRef.current) {
      createMandateMutation.mutate(mandateFrozenPayloadRef.current);
      return;
    }

    // 首次提交：本地校验（校验失败允许编辑，不冻结）
    try {
      const goal = newMandateGoal.trim();
      const prompt = newMandatePrompt.trim();
      const timezone = newMandateTimezone.trim();
      if (!goal) throw new Error('委托目标不能为空');
      if (!prompt) throw new Error('执行提示词不能为空');
      if (!timezone) throw new Error('时区不能为空（如 Asia/Shanghai）');
      const trigger = buildCreateTrigger();

      const id = mandateStableId || generateStableId('mandate');
      if (!mandateStableId) setMandateStableId(id);

      const payload: CreateCollaborationMandateInput = {
        id,
        goal,
        mode: newMandateMode,
        prompt,
        followupId: newMandateFollowupId.trim() || undefined,
        trigger,
        timezone,
        condition: newMandateCondition,
        catchupPolicy: newMandateCatchup
      };

      mandateFrozenPayloadRef.current = payload;
      createMandateMutation.mutate(payload);
    } catch (error) {
      setMandateError(error instanceof Error ? error.message : '创建失败');
    }
  };

  // ---- 委托任务：通用更新 (status / deliveryPaused) ----
  const updateMandateMutation = useMutation({
    mutationFn: (variables: {
      id: string;
      expectedRevision: number;
      patch: Omit<MandatePatch, 'expectedRevision'>;
    }) =>
      collaborationApi.updateMandate(appId, chatId, variables.id, {
        expectedRevision: variables.expectedRevision,
        ...variables.patch
      }),
    onSuccess: async () => {
      setMandateError(null);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: error =>
      setMandateError(
        isRevisionConflict(error)
          ? '委托任务已被他人更新（版本冲突），请刷新后重试。'
          : error instanceof Error
          ? error.message
          : '更新失败'
      )
  });

  // ---- 委托任务：改期 / 调频对话框 ----
  const [editingScheduleMandate, setEditingScheduleMandate] = useState<CollaborationMandateDetail | null>(null);
  const [editScheduleTriggerType, setEditScheduleTriggerType] = useState<'interval' | 'at' | 'cron'>('interval');
  const [editScheduleIntervalMinutes, setEditScheduleIntervalMinutes] = useState(60);
  const [editScheduleAtTime, setEditScheduleAtTime] = useState('');
  const [editScheduleCronExpr, setEditScheduleCronExpr] = useState('0 9 * * *');
  const [editScheduleTimezone, setEditScheduleTimezone] = useState('Asia/Shanghai');
  const [editScheduleConflict, setEditScheduleConflict] = useState(false);
  const [editScheduleError, setEditScheduleError] = useState<string | null>(null);
  const [editScheduleAnchorAt, setEditScheduleAnchorAt] = useState('');
  const editScheduleFrozenPayloadRef = useRef<ScheduleEditRequest | null>(null);

  const openEditSchedule = (mandate: CollaborationMandateDetail) => {
    saveEditScheduleMutation.reset();
    editScheduleFrozenPayloadRef.current = null;
    setEditScheduleAnchorAt(mandate.schedule?.trigger.kind === 'interval' ? mandate.schedule.trigger.anchorAt : new Date().toISOString());
    setEditingScheduleMandate(mandate);
    setEditScheduleConflict(false);
    setEditScheduleError(null);
    const trig = mandate.schedule?.trigger;
    if (trig?.kind === 'interval') {
      setEditScheduleTriggerType('interval');
      setEditScheduleIntervalMinutes(Math.max(1, Math.round(trig.everySeconds / 60)));
    } else if (trig?.kind === 'at') {
      setEditScheduleTriggerType('at');
      setEditScheduleAtTime(trig.localDateTime.slice(0, 16));
    } else if (trig?.kind === 'cron') {
      setEditScheduleTriggerType('cron');
      setEditScheduleCronExpr(trig.expression);
    } else {
      setEditScheduleTriggerType('interval');
      setEditScheduleIntervalMinutes(60);
    }
    setEditScheduleTimezone(mandate.schedule?.timezone || 'Asia/Shanghai');
  };

  const buildEditTrigger = (): ScheduleTrigger => {
    if (editScheduleTriggerType === 'interval') {
      const minutes = Math.floor(editScheduleIntervalMinutes);
      if (isNaN(minutes) || minutes < 1) {
        throw new Error('执行间隔必须至少为 1 分钟');
      }
      return {
        kind: 'interval',
        everySeconds: minutes * 60,
        anchorAt: editScheduleAnchorAt
      };
    }
    if (editScheduleTriggerType === 'at') {
      const normalized = normalizeLocalDateTime(editScheduleAtTime);
      if (!normalized || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(normalized)) {
        throw new Error('请选择有效的单次触发时间');
      }
      return { kind: 'at', localDateTime: normalized };
    }
    if (!editScheduleCronExpr.trim()) {
      throw new Error('Cron 表达式不能为空');
    }
    return { kind: 'cron', expression: editScheduleCronExpr.trim() };
  };

  const saveEditScheduleMutation = useMutation({
    mutationFn: (variables: ScheduleEditRequest) => {
      return collaborationApi.updateMandate(appId, chatId, variables.id, {
        expectedRevision: variables.expectedRevision,
        trigger: variables.trigger,
        timezone: variables.timezone
      });
    },
    onSuccess: async () => {
      editScheduleFrozenPayloadRef.current = null;
      setEditingScheduleMandate(null);
      setEditScheduleConflict(false);
      setEditScheduleError(null);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: error => {
      if (isRevisionConflict(error)) {
        setEditScheduleConflict(true);
      } else {
        setEditScheduleError(error instanceof Error ? error.message : '改期/调频失败');
      }
    }
  });

  // 背景刷新不改变草稿基准；结果未知的网络请求始终重试原 payload。
  const submitEditSchedule = () => {
    if (!editingScheduleMandate || saveEditScheduleMutation.isPending || editScheduleConflict) return;
    try {
      if (!editScheduleFrozenPayloadRef.current) {
        const timezone = editScheduleTimezone.trim();
        if (!timezone) throw new Error('时区不能为空（如 Asia/Shanghai）');
        editScheduleFrozenPayloadRef.current = {
          id: editingScheduleMandate.id,
          expectedRevision: editingScheduleMandate.revision,
          trigger: buildEditTrigger(),
          timezone
        };
      }
      saveEditScheduleMutation.mutate(editScheduleFrozenPayloadRef.current);
    } catch (error) {
      setEditScheduleError(error instanceof Error ? error.message : '改期/调频失败');
      setEditScheduleConflict(false);
    }
  };

  // ---- 决策纠正与回放 ----
  const [feedbackDecision, setFeedbackDecision] = useState<CollaborationDecision | null>(null);
  const [feedbackCorrection, setFeedbackCorrection] = useState('');
  const [feedbackExpectedAction, setFeedbackExpectedAction] = useState<
    'silent' | 'reply' | 'act' | ''
  >('');
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  const addFeedbackMutation = useMutation({
    mutationFn: (variables: {
      decisionId: string;
      correction: string;
      expectedAction?: 'silent' | 'reply' | 'act';
    }) =>
      collaborationApi.addFeedback(appId, chatId, variables.decisionId, {
        correction: variables.correction,
        expectedAction: variables.expectedAction
      }),
    onSuccess: async () => {
      setFeedbackDecision(null);
      setFeedbackCorrection('');
      setFeedbackExpectedAction('');
      setFeedbackError(null);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: error => setFeedbackError(error instanceof Error ? error.message : '提交失败')
  });

  const [replayResult, setReplayResult] = useState<CollaborationReplayResponse | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const replayMutation = useMutation({
    mutationFn: (decisionIds: string[]) =>
      collaborationApi.replay(appId, chatId, { decisionIds }),
    onSuccess: data => {
      setReplayResult(data);
      setReplayError(null);
    },
    onError: error => setReplayError(error instanceof Error ? error.message : '回放失败')
  });

  if (overviewQuery.isLoading) {
    return (
      <div
        className={`grid h-64 place-items-center rounded-lg border border-subtle bg-surface p-6 ${
          className ?? ''
        }`}
      >
        <Spinner label="正在读取通用协作数据…" />
      </div>
    );
  }

  if (overviewQuery.isError) {
    const error = overviewQuery.error;
    const forbidden = error instanceof ApiError && error.status === 403;
    return (
      <div className={`space-y-3 rounded-lg border border-subtle bg-surface p-6 ${className ?? ''}`}>
        <Banner
          tone="danger"
          action={{ label: '重试', onClick: () => void overviewQuery.refetch() }}
        >
          {forbidden
            ? '权限不足：当前身份没有查看或管理该群通用协作配置的权限。'
            : `加载群协作信息失败：${error instanceof Error ? error.message : '未知错误'}`}
        </Banner>
      </div>
    );
  }

  const overview = overviewQuery.data!;
  const snapshot = overview.snapshot;
  const bootstrap = snapshot.bootstrap;
  const followups = overview.followups ?? [];
  const mandates = overview.mandates ?? [];
  const actions = overview.actions ?? [];
  const decisions = overview.decisions ?? [];
  const feedbackList = overview.feedback ?? [];
  const openFollowupCount = followups.filter(f => f.status === 'open').length;
  const activeMandateCount = mandates.filter(m => m.status === 'active').length;

  // 外部动作过滤：排除内部 command 与 agent 内部状态动作
  const externalActions = actions.filter(a => isExternalCollaborationAction(a.kind));
  const unknownActions = externalActions.filter(a => a.status === 'unknown');

  const isFollowupFormFrozen =
    createFollowupMutation.isPending || Boolean(followupFrozenPayloadRef.current);
  const isMandateFormFrozen =
    createMandateMutation.isPending || Boolean(mandateFrozenPayloadRef.current);

  const formatTime = (value?: string) => (value ? new Date(value).toLocaleString() : '—');

  return (
    <div
      className={`space-y-4 rounded-lg border border-subtle bg-surface p-4 shadow-sm sm:p-6 ${
        className ?? ''
      }`}
    >
      {/* 头部 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-title font-semibold text-primary">群通用协作管理</h3>
            <Badge tone="accent">上下文 v{snapshot.contextRevision}</Badge>
            {bootstrap && (
              <Badge
                tone={
                  bootstrap.status === 'complete'
                    ? 'success'
                    : bootstrap.status === 'failed'
                    ? 'danger'
                    : 'warning'
                }
              >
                历史补读：{bootstrap.status}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-caption text-secondary">
            机器人 <span className="font-semibold text-primary">{botName || appId}</span> 在群聊{' '}
            <span className="font-semibold text-primary">{groupName || chatId}</span>{' '}
            的参与模式、长期指令、待办与委托。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={bootstrapMutation.isPending}
            onClick={() => bootstrapMutation.mutate()}
          >
            <RotateCw size={14} className="mr-1.5" />
            重新补读历史
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={overviewQuery.isFetching}
            onClick={() => void overviewQuery.refetch()}
            aria-label="刷新协作数据"
          >
            <RefreshCw size={14} />
          </Button>
        </div>
      </div>

      {bootstrapMutation.isSuccess && (
        <Banner tone="success" onDismiss={() => bootstrapMutation.reset()}>
          群聊历史上下文补读已触发。
        </Banner>
      )}
      {bootstrapError && <Banner tone="danger">{bootstrapError}</Banner>}

      {bootstrap && bootstrap.missing.length > 0 && (
        <Banner tone="warning">
          历史上下文存在缺失：<span className="font-mono text-meta">{bootstrap.missing.join(', ')}</span>
          。可点「重新补读历史」尝试补齐；补读只保存上下文，不会触发执行。
        </Banner>
      )}

      {unknownActions.length > 0 && (
        <Banner tone="warning">
          有 {unknownActions.length} 个外部投递结果待人工核对（unknown）。系统不会自动按未知结果重发，请在「动作核对」里核实。
        </Banner>
      )}

      <Tabs<ActiveTab>
        label="群协作管理导航"
        value={activeTab}
        onChange={setActiveTab}
        items={[
          { id: 'settings', label: '协作设置' },
          { id: 'followups', label: `待办事项 (${openFollowupCount}/${followups.length})` },
          { id: 'mandates', label: `委托任务 (${activeMandateCount}/${mandates.length})` },
          {
            id: 'actions',
            label: `动作核对${unknownActions.length > 0 ? ` (${unknownActions.length})` : ''}`
          },
          { id: 'decisions', label: `决策与回放 (${decisions.length})` }
        ]}
      />

      {/* ---------- 设置 ---------- */}
      {activeTab === 'settings' && (
        <div className="space-y-4 pt-1">
          {settingsConflict && (
            <Banner
              tone="danger"
              action={{
                label: '放弃草稿并载入最新',
                onClick: () => {
                  setSettingsConflict(false);
                  setSettingsDraft(null);
                  void overviewQuery.refetch();
                }
              }}
            >
              设置已被他人修改（版本冲突）。你编辑的内容仍保留在表单里，没有提交；请核对后再保存，或放弃草稿载入最新版本。
            </Banner>
          )}
          {settingsError && !settingsConflict && <Banner tone="danger">{settingsError}</Banner>}
          {settingsSuccess && (
            <Banner tone="success" onDismiss={() => setSettingsSuccess(false)}>
              协作设置已保存。
            </Banner>
          )}

          {draft && (
            <>
              <div className="space-y-2">
                <div className="text-body font-semibold text-primary">参与模式</div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {(['off', 'observe', 'selective'] as const).map(mode => {
                    const selected = draft.participation === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          setSettingsDraft({ ...draft, participation: mode });
                          setSettingsSuccess(false);
                        }}
                        className={`rounded-lg border p-3 text-left transition-colors ${
                          selected
                            ? 'border-action bg-action-soft shadow-sm'
                            : 'border-subtle hover:bg-hover'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <strong className="text-body font-medium text-primary">
                            {participationLabels[mode].title}
                          </strong>
                          {selected && <Check size={16} className="text-action" />}
                        </div>
                        <p className="mt-1 text-caption text-subtle">{participationLabels[mode].desc}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <Field label="长期指令" hint="进入该群的判定与任务提示词，最多 8000 字。">
                <Textarea
                  rows={4}
                  maxLength={8000}
                  value={draft.instructions}
                  onChange={e => {
                    setSettingsDraft({ ...draft, instructions: e.target.value });
                    setSettingsSuccess(false);
                  }}
                  placeholder="例如：优先中文沟通；评审方案时先核对测试与回滚；未经要求不主动触发发布。"
                />
              </Field>

              <div className="grid gap-4 rounded-lg border border-subtle bg-muted p-4 sm:grid-cols-2">
                <Field label="每小时主动投递上限（0–60）">
                  <Input
                    type="number"
                    min={0}
                    max={60}
                    className="w-32"
                    value={draft.maxProactivePerHour}
                    onChange={e => {
                      const value = Math.min(60, Math.max(0, Number(e.target.value) || 0));
                      setSettingsDraft({ ...draft, maxProactivePerHour: value });
                      setSettingsSuccess(false);
                    }}
                  />
                </Field>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-default text-action focus:ring-action"
                    checked={draft.notificationsPaused}
                    onChange={e => {
                      setSettingsDraft({ ...draft, notificationsPaused: e.target.checked });
                      setSettingsSuccess(false);
                    }}
                  />
                  <span>
                    <span className="block text-caption font-semibold text-primary">
                      全群主动投递暂停
                    </span>
                    <span className="mt-1 block text-meta text-subtle">
                      暂停所有定时委托与主动通知，但显式 @ 仍正常响应。
                    </span>
                  </span>
                </label>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle pt-3">
                <div className="text-caption text-subtle">
                  {isSettingsDirty ? (
                    <span className="font-medium text-warning">● 有未保存的修改</span>
                  ) : (
                    <span>当前为已保存版本（rev {draft.revision}）。</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    disabled={!isSettingsDirty || saveSettingsMutation.isPending}
                    onClick={() => {
                      setSettingsDraft(null);
                      setSettingsConflict(false);
                      setSettingsError(null);
                    }}
                  >
                    放弃修改
                  </Button>
                  <Button
                    variant="primary"
                    disabled={!isSettingsDirty}
                    loading={saveSettingsMutation.isPending}
                    onClick={() => saveSettingsMutation.mutate(draft)}
                  >
                    <Check size={14} className="mr-1.5" />
                    保存设置
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---------- 待办事项 ---------- */}
      {activeTab === 'followups' && (
        <div className="space-y-4 pt-1">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h4 className="text-body font-semibold text-primary">待办与跟进事项</h4>
              <p className="text-caption text-subtle">跟踪群内讨论出的目标、进展与步骤。</p>
            </div>
            <Button variant="primary" size="sm" onClick={openNewFollowupDialog}>
              <Plus size={14} className="mr-1" />
              新建事项
            </Button>
          </div>

          {/* 新建对话框打开时错误在对话框内显示，避免重复 */}
          {followupError && !createFollowupOpen && <Banner tone="danger">{followupError}</Banner>}

          {followups.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 size={32} className="text-subtle" />}
              title="暂无待办事项"
              description="群内没有待办或跟进任务，可点右上角新建。"
            />
          ) : (
            <div className="space-y-3">
              {followups.map(item => {
                const isOpen = item.status === 'open';
                const pending = updateFollowupMutation.isPending;
                const isEditingProgress = editingProgressId === item.id;
                const isConflict = progressConflictId === item.id;

                return (
                  <Card key={item.id} className="space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="text-body font-semibold text-primary">{item.goal}</strong>
                          <Badge
                            tone={
                              item.status === 'open'
                                ? 'accent'
                                : item.status === 'completed'
                                ? 'success'
                                : 'neutral'
                            }
                          >
                            {item.status === 'open' ? '进行中' : item.status === 'completed' ? '已完成' : '已取消'}
                          </Badge>
                          <span className="text-meta text-subtle">rev {item.revision}</span>
                        </div>
                        {item.progress && !isEditingProgress && (
                          <p className="mt-1 text-caption text-secondary">
                            <span className="font-semibold">进展：</span>
                            {item.progress}
                          </p>
                        )}
                        {item.result && (
                          <p className="mt-1 text-caption text-secondary">
                            <span className="font-semibold">结果：</span>
                            {item.result}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {isOpen && !isEditingProgress && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => startEditProgress(item.id, item.progress ?? '', item.revision)}
                          >
                            <Edit3 size={14} className="mr-1" />
                            编辑进展
                          </Button>
                        )}
                        {isOpen && (
                          <>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={pending}
                              onClick={() =>
                                updateFollowupMutation.mutate({
                                  id: item.id,
                                  expectedRevision: item.revision,
                                  patch: { status: 'completed' }
                                })
                              }
                            >
                              <Check size={14} className="mr-1 text-success" />
                              完成
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={pending}
                              onClick={() =>
                                updateFollowupMutation.mutate({
                                  id: item.id,
                                  expectedRevision: item.revision,
                                  patch: { status: 'cancelled' }
                                })
                              }
                            >
                              <X size={14} className="mr-1 text-danger" />
                              取消
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* 进展编辑面板 */}
                    {isEditingProgress && (
                      <div className="space-y-2 rounded border border-subtle bg-muted p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-caption font-semibold text-primary">编辑事项进展</span>
                          <span className="text-meta text-subtle">基于 rev {progressDrafts[item.id]?.baseRevision}</span>
                        </div>

                        {isConflict && (
                          <Banner
                            tone="danger"
                            action={{
                              label: '重新读取当前版本',
                              onClick: async () => {
                                const result = await overviewQuery.refetch();
                                const current = result.data?.followups.find(followup => followup.id === item.id);
                                if (result.isError || !current) {
                                  setProgressError(result.error?.message ?? '当前事项不可用，草稿仍保留。');
                                  return;
                                }
                                setProgressDrafts(prev => ({ ...prev, [item.id]: { ...prev[item.id], baseRevision: current.revision } }));
                                setProgressConflictId(null);
                                setProgressError(null);
                              }
                            }}
                          >
                            更新进展冲突：服务端事项已被他人更新。你的进展草稿已保留，请比较后再次保存。
                          </Banner>
                        )}
                        {progressError && <Banner tone="danger">{progressError}</Banner>}

                        <Textarea
                          rows={3}
                          disabled={saveProgressMutation.isPending}
                          value={progressDrafts[item.id]?.value ?? ''}
                          onChange={e => {
                            setProgressDrafts(prev => ({ ...prev, [item.id]: { ...prev[item.id], value: e.target.value } }));
                            setProgressError(null);
                          }}
                          placeholder="填写事项最新进展情况…"
                        />

                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={saveProgressMutation.isPending}
                            onClick={() => {
                              setEditingProgressId(null);
                              setProgressConflictId(null);
                              setProgressError(null);
                            }}
                          >
                            取消
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            loading={saveProgressMutation.isPending}
                            disabled={isConflict}
                            onClick={() =>
                              saveProgressMutation.mutate({
                                id: item.id,
                                expectedRevision: progressDrafts[item.id]!.baseRevision,
                                progress: progressDrafts[item.id]!.value
                              })
                            }
                          >
                            保存进展
                          </Button>
                        </div>
                      </div>
                    )}

                    {item.steps.length > 0 && (
                      <div className="space-y-1.5 rounded bg-muted p-2.5">
                        <div className="text-meta font-semibold text-subtle">步骤</div>
                        {item.steps.map(step => (
                          <label key={step.id} className="flex cursor-pointer items-center gap-2 text-caption">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 rounded border-default text-action focus:ring-action"
                              checked={step.status === 'done'}
                              disabled={!isOpen || pending}
                              onChange={e => {
                                const steps = item.steps.map(s =>
                                  s.id === step.id
                                    ? { ...s, status: (e.target.checked ? 'done' : 'open') as 'done' | 'open' }
                                    : s
                                );
                                updateFollowupMutation.mutate({
                                  id: item.id,
                                  expectedRevision: item.revision,
                                  patch: { steps }
                                });
                              }}
                            />
                            <span className={step.status === 'done' ? 'text-subtle line-through' : 'text-primary'}>
                              {step.label}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-subtle">
                      {item.ownerId && <span>负责人：{item.ownerId}</span>}
                      {item.dueAt && <span>截止：{formatTime(item.dueAt)}</span>}
                      <span>来源：{item.provenance}</span>
                      <span>更新：{formatTime(item.updatedAt)}</span>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          <Dialog
            open={createFollowupOpen}
            onClose={closeNewFollowupDialog}
            closeOnEscape={!createFollowupMutation.isPending}
            closeOnScrim={!createFollowupMutation.isPending}
            label="新建待办事项"
            size="md"
          >
            <Dialog.Header>
              <h3 className="text-body font-semibold text-primary">新建待办事项</h3>
            </Dialog.Header>
            <Dialog.Body className="space-y-4">
              {/*
                请求 pending 或失败后冻结表单：服务端按 id 幂等，相同 id 必须配相同 payload。
                此时只允许重试或取消后重开（生成新 id），不能改内容再用旧 id 提交。
              */}
              <fieldset disabled={isFollowupFormFrozen} className="space-y-4">
              <Field label="目标" required>
                <Input
                  disabled={isFollowupFormFrozen}
                  value={newFollowupGoal}
                  onChange={e => {
                    setNewFollowupGoal(e.target.value);
                    setFollowupError(null);
                  }}
                  placeholder="例如：梳理本周接口改造方案与依赖"
                />
              </Field>
              <Field label="初始进展">
                <Textarea
                  disabled={isFollowupFormFrozen}
                  rows={2}
                  value={newFollowupProgress}
                  onChange={e => setNewFollowupProgress(e.target.value)}
                  placeholder="当前背景或已有进展…"
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="负责人 ID（可选）">
                  <Input
                    disabled={isFollowupFormFrozen}
                    value={newFollowupOwnerId}
                    onChange={e => setNewFollowupOwnerId(e.target.value)}
                    placeholder="成员 ID"
                  />
                </Field>
                <Field label="截止时间（可选）">
                  <Input
                    disabled={isFollowupFormFrozen}
                    type="datetime-local"
                    value={newFollowupDueAt}
                    onChange={e => setNewFollowupDueAt(e.target.value)}
                  />
                </Field>
              </div>
              <div className="space-y-2">
                <div className="text-caption font-semibold text-primary">拆解步骤</div>
                {newFollowupSteps.length > 0 && (
                  <ul className="space-y-1">
                    {newFollowupSteps.map((step, idx) => (
                      <li
                        key={idx}
                        className="flex items-center justify-between rounded bg-muted px-2.5 py-1 text-caption"
                      >
                        <span>{step}</span>
                        <button
                          type="button"
                          disabled={isFollowupFormFrozen}
                          aria-label={`移除步骤 ${step}`}
                          onClick={() => setNewFollowupSteps(newFollowupSteps.filter((_, i) => i !== idx))}
                        >
                          <X size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex gap-2">
                  <Input
                    disabled={isFollowupFormFrozen}
                    value={newStepInput}
                    onChange={e => setNewStepInput(e.target.value)}
                    placeholder="输入步骤后回车或点添加"
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newStepInput.trim() && !isFollowupFormFrozen) {
                        e.preventDefault();
                        setNewFollowupSteps([...newFollowupSteps, newStepInput.trim()]);
                        setNewStepInput('');
                      }
                    }}
                  />
                  <Button
                    variant="secondary"
                    disabled={isFollowupFormFrozen || !newStepInput.trim()}
                    onClick={() => {
                      setNewFollowupSteps([...newFollowupSteps, newStepInput.trim()]);
                      setNewStepInput('');
                    }}
                  >
                    添加
                  </Button>
                </div>
              </div>
              </fieldset>
              {createFollowupMutation.isError && Boolean(followupFrozenPayloadRef.current) && (
                <Banner tone="warning">
                  创建请求失败，已冻结当前内容与 ID。请直接「重试创建事项」（相同内容不会重复创建）；如需修改内容，请取消后重新新建。
                </Banner>
              )}
              {followupError && createFollowupOpen && <Banner tone="danger">{followupError}</Banner>}
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" disabled={createFollowupMutation.isPending} onClick={closeNewFollowupDialog}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={!newFollowupGoal.trim() && !followupFrozenPayloadRef.current}
                loading={createFollowupMutation.isPending}
                onClick={submitCreateFollowup}
              >
                {followupFrozenPayloadRef.current ? '重试创建事项' : '创建事项'}
              </Button>
            </Dialog.Footer>
          </Dialog>
        </div>
      )}

      {/* ---------- 委托任务 ---------- */}
      {activeTab === 'mandates' && (
        <div className="space-y-4 pt-1">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h4 className="text-body font-semibold text-primary">委托任务与调度</h4>
              <p className="text-caption text-subtle">固定提醒或周期性 Agent 分析，可关联待办事项。</p>
            </div>
            <Button variant="primary" size="sm" onClick={openNewMandateDialog}>
              <Plus size={14} className="mr-1" />
              新建委托
            </Button>
          </div>

          {/* 新建对话框打开时创建错误在对话框内显示，避免重复 */}
          {mandateError && !createMandateOpen && <Banner tone="danger">{mandateError}</Banner>}

          {mandates.length === 0 ? (
            <EmptyState
              icon={<Clock size={32} className="text-subtle" />}
              title="暂无委托任务"
              description="可以创建固定提醒或周期性 Agent 巡检。"
            />
          ) : (
            <div className="space-y-3">
              {mandates.map(mandate => {
                const terminal = mandate.status === 'cancelled' || mandate.status === 'completed';
                const active = mandate.status === 'active';
                const paused = mandate.status === 'paused';
                const pending = updateMandateMutation.isPending;
                const patch = (p: Omit<MandatePatch, 'expectedRevision'>) =>
                  updateMandateMutation.mutate({
                    id: mandate.id,
                    expectedRevision: mandate.revision,
                    patch: p
                  });
                return (
                  <Card key={mandate.id} className="space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="text-body font-semibold text-primary">{mandate.goal}</strong>
                          <Badge tone={mandate.mode === 'agent' ? 'accent' : 'neutral'}>
                            {mandate.mode === 'agent' ? 'Agent 分析' : '固定提醒'}
                          </Badge>
                          <Badge tone={active ? 'success' : paused ? 'warning' : 'neutral'}>
                            {active ? '运行中' : paused ? '已暂停' : mandate.status === 'cancelled' ? '已取消' : '已完成'}
                          </Badge>
                          <Badge tone={mandate.deliveryPaused ? 'warning' : 'neutral'}>
                            {mandate.deliveryPaused ? '投递已暂停' : '投递正常'}
                          </Badge>
                          <span className="text-meta text-subtle">rev {mandate.revision}</span>
                        </div>
                        <p className="mt-1 text-caption text-secondary">
                          <span className="font-semibold">提示词：</span>
                          {mandate.prompt}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {!terminal && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditSchedule(mandate)}
                          >
                            <Edit3 size={14} className="mr-1" />
                            改期/调频
                          </Button>
                        )}
                        {active && (
                          <Button variant="secondary" size="sm" disabled={pending} onClick={() => patch({ status: 'paused' })}>
                            <Pause size={14} className="mr-1" />
                            暂停执行
                          </Button>
                        )}
                        {paused && !terminal && (
                          <Button variant="secondary" size="sm" disabled={pending} onClick={() => patch({ status: 'active' })}>
                            <Play size={14} className="mr-1 text-success" />
                            恢复执行
                          </Button>
                        )}
                        {!terminal && mandate.deliveryPaused ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            title="恢复向群内主动投递，不改变委托执行状态"
                            onClick={() => patch({ deliveryPaused: false })}
                          >
                            <Bell size={14} className="mr-1 text-success" />
                            恢复投递
                          </Button>
                        ) : null}
                        {!terminal && !mandate.deliveryPaused ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            title="只暂停投递，不关闭委托或关联事项"
                            onClick={() => patch({ deliveryPaused: true })}
                          >
                            <BellOff size={14} className="mr-1" />
                            暂停投递
                          </Button>
                        ) : null}
                        {!terminal && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-danger hover:bg-danger-soft"
                            disabled={pending}
                            onClick={() => patch({ status: 'cancelled' })}
                          >
                            <X size={14} className="mr-1" />
                            取消委托
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-subtle">
                      {mandate.nextDueAt && (
                        <span className="font-semibold text-primary">下次执行：{formatTime(mandate.nextDueAt)}</span>
                      )}
                      <span>
                        条件：
                        {mandate.condition === 'always'
                          ? '总是执行'
                          : mandate.condition === 'followup_open'
                          ? '关联事项进行中'
                          : '长时间无进展'}
                      </span>
                      {mandate.schedule?.timezone && <span>时区：{mandate.schedule.timezone}</span>}
                      {mandate.followupId && <span>关联事项：{mandate.followupId}</span>}
                      <span>堆积：{mandate.catchupPolicy === 'skip' ? '跳过' : '合并'}</span>
                      <span>委托人：{mandate.requesterId}</span>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          {/* 新建委托对话框 */}
          <Dialog
            open={createMandateOpen}
            onClose={closeNewMandateDialog}
            closeOnEscape={!createMandateMutation.isPending}
            closeOnScrim={!createMandateMutation.isPending}
            label="新建委托任务"
            size="md"
          >
            <Dialog.Header>
              <h3 className="text-body font-semibold text-primary">新建委托任务</h3>
            </Dialog.Header>
            <Dialog.Body className="space-y-4">
              {/* 请求 pending 或提交失败后冻结表单：服务端按 id 幂等，相同 id 必须配相同 payload。 */}
              <fieldset disabled={isMandateFormFrozen} className="space-y-4">
              <Field label="委托目标" required>
                <Input
                  disabled={isMandateFormFrozen}
                  value={newMandateGoal}
                  onChange={e => {
                    setNewMandateGoal(e.target.value);
                    setMandateError(null);
                  }}
                  placeholder="例如：每个工作日巡检群内提单状态并提醒"
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="模式" required>
                  <Select
                    disabled={isMandateFormFrozen}
                    value={newMandateMode}
                    onChange={e => setNewMandateMode(e.target.value as 'notify' | 'agent')}
                  >
                    <option value="agent">Agent 分析</option>
                    <option value="notify">固定提醒</option>
                  </Select>
                </Field>
                <Field label="关联待办事项（可选）">
                  <Select
                    disabled={isMandateFormFrozen}
                    value={newMandateFollowupId}
                    onChange={e => setNewMandateFollowupId(e.target.value)}
                  >
                    <option value="">不关联</option>
                    {followups.map(f => (
                      <option key={f.id} value={f.id}>
                        {f.goal}（{f.status}）
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="执行提示词" required>
                <Textarea
                  disabled={isMandateFormFrozen}
                  rows={3}
                  maxLength={8000}
                  value={newMandatePrompt}
                  onChange={e => {
                    setNewMandatePrompt(e.target.value);
                    setMandateError(null);
                  }}
                  placeholder="每次触发时发给 Agent 的任务提示词…"
                />
              </Field>

              <div className="space-y-3 rounded-lg border border-subtle bg-muted p-3">
                <div className="text-caption font-semibold text-primary">调度</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="触发方式">
                    <Select
                      disabled={isMandateFormFrozen}
                      value={newMandateTriggerType}
                      onChange={e => {
                        setNewMandateTriggerType(e.target.value as 'interval' | 'at' | 'cron');
                        setMandateError(null);
                      }}
                    >
                      <option value="interval">固定间隔</option>
                      <option value="at">单次指定时间</option>
                      <option value="cron">Cron 表达式</option>
                    </Select>
                  </Field>
                  {newMandateTriggerType === 'interval' && (
                    <Field label="间隔（分钟，≥1）">
                      <Input
                        disabled={isMandateFormFrozen}
                        type="number"
                        min={1}
                        value={newMandateIntervalMinutes}
                        onChange={e => {
                          setNewMandateIntervalMinutes(Number(e.target.value));
                          setMandateError(null);
                        }}
                      />
                    </Field>
                  )}
                  {newMandateTriggerType === 'at' && (
                    <Field label="触发时间">
                      <Input
                        disabled={isMandateFormFrozen}
                        type="datetime-local"
                        value={newMandateAtTime}
                        onChange={e => {
                          setNewMandateAtTime(e.target.value);
                          setMandateError(null);
                        }}
                      />
                    </Field>
                  )}
                  {newMandateTriggerType === 'cron' && (
                    <Field label="Cron 表达式" hint="例如 0 9 * * 1-5 表示工作日每天 9 点。">
                      <Input
                        disabled={isMandateFormFrozen}
                        value={newMandateCronExpr}
                        onChange={e => {
                          setNewMandateCronExpr(e.target.value);
                          setMandateError(null);
                        }}
                      />
                    </Field>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="时区">
                    <Input
                      disabled={isMandateFormFrozen}
                      value={newMandateTimezone}
                      onChange={e => {
                        setNewMandateTimezone(e.target.value);
                        setMandateError(null);
                      }}
                    />
                  </Field>
                  <Field label="触发条件">
                    <Select
                      disabled={isMandateFormFrozen}
                      value={newMandateCondition}
                      onChange={e =>
                        setNewMandateCondition(e.target.value as 'always' | 'followup_open' | 'no_progress')
                      }
                    >
                      <option value="always">总是执行</option>
                      <option value="followup_open">关联事项进行中</option>
                      <option value="no_progress">长时间无进展</option>
                    </Select>
                  </Field>
                  <Field label="错过后的堆积处理">
                    <Select
                      disabled={isMandateFormFrozen}
                      value={newMandateCatchup}
                      onChange={e => setNewMandateCatchup(e.target.value as 'skip' | 'coalesce')}
                    >
                      <option value="skip">跳过</option>
                      <option value="coalesce">合并执行一次</option>
                    </Select>
                  </Field>
                </div>
              </div>
              </fieldset>
              {createMandateMutation.isError && Boolean(mandateFrozenPayloadRef.current) && (
                <Banner tone="warning">
                  创建请求失败，已冻结当前计划与 ID。请直接「重试创建委托」（相同内容不会重复创建）；如需修改内容，请取消后重新新建。
                </Banner>
              )}
              {mandateError && createMandateOpen && <Banner tone="danger">{mandateError}</Banner>}
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" disabled={createMandateMutation.isPending} onClick={closeNewMandateDialog}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={(!newMandateGoal.trim() || !newMandatePrompt.trim()) && !mandateFrozenPayloadRef.current}
                loading={createMandateMutation.isPending}
                onClick={submitCreateMandate}
              >
                {mandateFrozenPayloadRef.current ? '重试创建委托' : '创建委托'}
              </Button>
            </Dialog.Footer>
          </Dialog>

          {/* 委托改期 / 调频对话框 */}
          {editingScheduleMandate && (
            <Dialog
              open={Boolean(editingScheduleMandate)}
              onClose={() => {
                if (!saveEditScheduleMutation.isPending) setEditingScheduleMandate(null);
              }}
              closeOnEscape={!saveEditScheduleMutation.isPending}
              closeOnScrim={!saveEditScheduleMutation.isPending}
              label={`委托改期与调频 · ${editingScheduleMandate.goal}`}
              size="md"
            >
              <Dialog.Header>
                <div className="min-w-0 flex-1">
                  <h3 className="text-body font-semibold text-primary">改期与调频</h3>
                  <p className="mt-0.5 text-caption text-subtle">
                    目标：{editingScheduleMandate.goal}（基于 rev {editingScheduleMandate.revision}）
                  </p>
                </div>
              </Dialog.Header>
              <Dialog.Body className="space-y-4">
                {editScheduleConflict && (
                  <Banner
                    tone="danger"
                    action={{
                      label: '重新读取当前版本',
                      onClick: async () => {
                        const result = await overviewQuery.refetch();
                        const latestMandate = result.data?.mandates.find(m => m.id === editingScheduleMandate.id);
                        if (result.isError || !latestMandate) {
                          setEditScheduleError(result.error?.message ?? '当前委托不可用，草稿仍保留。');
                          return;
                        }
                        setEditingScheduleMandate(latestMandate);
                        editScheduleFrozenPayloadRef.current = null;
                        saveEditScheduleMutation.reset();
                        setEditScheduleConflict(false);
                        setEditScheduleError(null);
                      }
                    }}
                  >
                    委托计划已被他人更新（版本冲突）。你选择的改期/调频参数已保留，可重新读取最新版本后再次提交。
                  </Banner>
                )}
                {editScheduleError && <Banner tone="danger">{editScheduleError}</Banner>}

                <fieldset disabled={Boolean(editScheduleFrozenPayloadRef.current) || saveEditScheduleMutation.isPending} className="space-y-3 rounded-lg border border-subtle bg-muted p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="触发方式">
                      <Select
                        value={editScheduleTriggerType}
                        onChange={e => {
                          setEditScheduleTriggerType(e.target.value as 'interval' | 'at' | 'cron');
                          setEditScheduleError(null);
                        }}
                      >
                        <option value="interval">固定间隔</option>
                        <option value="at">单次指定时间</option>
                        <option value="cron">Cron 表达式</option>
                      </Select>
                    </Field>
                    {editScheduleTriggerType === 'interval' && (
                      <Field label="间隔（分钟，≥1）">
                        <Input
                          type="number"
                          min={1}
                          value={editScheduleIntervalMinutes}
                          onChange={e => {
                            setEditScheduleIntervalMinutes(Number(e.target.value));
                            setEditScheduleError(null);
                          }}
                        />
                      </Field>
                    )}
                    {editScheduleTriggerType === 'at' && (
                      <Field label="触发时间">
                        <Input
                          type="datetime-local"
                          value={editScheduleAtTime}
                          onChange={e => {
                            setEditScheduleAtTime(e.target.value);
                            setEditScheduleError(null);
                          }}
                        />
                      </Field>
                    )}
                    {editScheduleTriggerType === 'cron' && (
                      <Field label="Cron 表达式" hint="例如 0 9 * * 1-5">
                        <Input
                          value={editScheduleCronExpr}
                          onChange={e => {
                            setEditScheduleCronExpr(e.target.value);
                            setEditScheduleError(null);
                          }}
                        />
                      </Field>
                    )}
                  </div>
                  <Field label="时区">
                    <Input
                      value={editScheduleTimezone}
                      onChange={e => {
                        setEditScheduleTimezone(e.target.value);
                        setEditScheduleError(null);
                      }}
                    />
                  </Field>
                </fieldset>
                {saveEditScheduleMutation.isError && !editScheduleConflict && (
                  <Banner tone="warning">请求结果尚未确认，重试将提交同一份改期内容。</Banner>
                )}
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="ghost" disabled={saveEditScheduleMutation.isPending} onClick={() => setEditingScheduleMandate(null)}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  loading={saveEditScheduleMutation.isPending}
                  disabled={editScheduleConflict}
                  onClick={submitEditSchedule}
                >
                  {saveEditScheduleMutation.isError && !editScheduleConflict ? '重试计划更新' : '保存计划更新'}
                </Button>
              </Dialog.Footer>
            </Dialog>
          )}
        </div>
      )}

      {/* ---------- 动作核对 ---------- */}
      {activeTab === 'actions' && (
        <div className="space-y-4 pt-1">
          <div>
            <h4 className="text-body font-semibold text-primary">外部动作核对</h4>
            <p className="text-caption text-subtle">
              委托或判定产生的外部投递动作。unknown 表示结果不明，需人工核对，系统不会自动重发；内部指令不在此等待通知。
            </p>
          </div>
          {externalActions.length === 0 ? (
            <EmptyState
              icon={<Shield size={32} className="text-subtle" />}
              title="暂无外部动作记录"
              description="发生外部投递动作后在此沉淀审计与核对记录。"
            />
          ) : (
            <div className="space-y-3">
              {externalActions.map(action => (
                <Card
                  key={action.id}
                  tone={action.status === 'unknown' ? 'muted' : 'default'}
                  className={action.status === 'unknown' ? 'border border-warning-border' : undefined}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-body font-semibold text-primary">{action.kind}</strong>
                      <Badge
                        tone={
                          action.status === 'succeeded'
                            ? 'success'
                            : action.status === 'failed'
                            ? 'danger'
                            : action.status === 'unknown'
                            ? 'warning'
                            : 'neutral'
                        }
                      >
                        {action.status === 'unknown' ? '待核对' : action.status}
                      </Badge>
                      <span className="font-mono text-meta text-subtle">{action.id}</span>
                    </div>
                    <span className="text-meta text-subtle">{formatTime(action.createdAt)}</span>
                  </div>
                  {action.error && (
                    <div className="rounded bg-danger-soft p-2 text-caption text-danger">错误：{action.error}</div>
                  )}
                  {action.receipt && (
                    <div className="text-meta text-subtle">
                      回执：<span className="font-mono">{action.receipt}</span>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-x-4 text-meta text-subtle">
                    <span>发起者：{action.requesterId}</span>
                    {action.mandateId && <span>关联委托：{action.mandateId}</span>}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---------- 决策与回放 ---------- */}
      {activeTab === 'decisions' && (
        <div className="space-y-4 pt-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="text-body font-semibold text-primary">决策记录与回放</h4>
              <p className="text-caption text-subtle">
                审查协作判定，提交人工纠正；回放为只读判断，不会触发外部动作。
              </p>
            </div>
            {decisions.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                loading={replayMutation.isPending}
                onClick={() => replayMutation.mutate(decisions.map(d => d.id))}
              >
                <RotateCw size={14} className="mr-1.5" />
                回放全部决策
              </Button>
            )}
          </div>

          {replayError && <Banner tone="danger">{replayError}</Banner>}

          {replayResult && (
            <Card tone="muted" padding="md" className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 border-b border-subtle pb-2">
                <strong className="text-body font-semibold text-primary">回放结果</strong>
                <Badge tone="success">通过 {replayResult.passed}</Badge>
                <Badge tone={replayResult.failed > 0 ? 'danger' : 'neutral'}>失败 {replayResult.failed}</Badge>
                <Badge tone={replayResult.missing > 0 ? 'warning' : 'neutral'}>缺失 {replayResult.missing}</Badge>
                <span className="text-caption text-subtle">缺失不计为通过。</span>
              </div>
              <div className="space-y-2">
                {replayResult.results.map((r, idx) => (
                  <div
                    key={`${r.decisionId}-${idx}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded bg-surface p-2 text-caption"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-meta">{r.decisionId}</span>
                      <Badge tone={r.status === 'passed' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>
                        {r.status === 'passed' ? '通过' : r.status === 'failed' ? '失败' : '缺失'}
                      </Badge>
                    </div>
                    {r.reason && <span className="text-meta text-subtle">{r.reason}</span>}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {decisions.length === 0 ? (
            <EmptyState
              icon={<HelpCircle size={32} className="text-subtle" />}
              title="暂无决策记录"
              description="机器人在本群产生协作判定后记录在此，可供纠正与回放。"
            />
          ) : (
            <div className="space-y-3">
              {decisions.map(decision => {
                const feedbacks = feedbackList.filter(f => f.decisionId === decision.id);
                return (
                  <Card key={decision.id} className="space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="text-body font-semibold text-primary">
                            判定：
                            {decision.action === 'silent'
                              ? '静默'
                              : decision.action === 'reply'
                              ? '回复'
                              : '执行动作'}
                          </strong>
                          <Badge tone="neutral">{decision.status}</Badge>
                          <span className="font-mono text-meta text-subtle">{decision.id}</span>
                        </div>
                        <p className="text-caption text-secondary">
                          <span className="font-semibold">原因：</span>
                          {decision.reason}
                        </p>
                        {decision.response && (
                          <p className="rounded bg-muted p-2 text-caption text-primary">
                            <span className="font-semibold">回复：</span>
                            {decision.response}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setFeedbackDecision(decision);
                          setFeedbackCorrection('');
                          setFeedbackExpectedAction('');
                          setFeedbackError(null);
                        }}
                      >
                        人工纠正
                      </Button>
                    </div>
                    {feedbacks.length > 0 && (
                      <div className="space-y-1 rounded bg-muted p-2.5">
                        <div className="text-meta font-semibold text-subtle">人工纠正</div>
                        {feedbacks.map(f => (
                          <div key={f.id} className="text-caption text-secondary">
                            <span className="font-semibold">{f.actorId}：</span>
                            {f.correction}
                            {f.expectedAction && (
                              <span className="ml-2 text-meta text-subtle">（期望：{f.expectedAction}）</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="text-meta text-subtle">
                      {formatTime(decision.createdAt)} · 策略版本 {decision.policyVersion}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          <Dialog
            open={Boolean(feedbackDecision)}
            onClose={() => setFeedbackDecision(null)}
            label="人工纠正决策"
            size="md"
          >
            <Dialog.Header>
              <h3 className="text-body font-semibold text-primary">人工纠正决策</h3>
            </Dialog.Header>
            <Dialog.Body className="space-y-4">
              {feedbackDecision && (
                <div className="space-y-1 rounded bg-muted p-3 text-caption">
                  <div>
                    <span className="text-subtle">原判定：</span>
                    <strong className="text-primary">{feedbackDecision.action}</strong>
                  </div>
                  <div className="text-secondary">
                    <span className="text-subtle">原因：</span>
                    {feedbackDecision.reason}
                  </div>
                </div>
              )}
              <Field label="纠正说明" required>
                <Textarea
                  rows={3}
                  maxLength={4000}
                  value={feedbackCorrection}
                  onChange={e => setFeedbackCorrection(e.target.value)}
                  placeholder="说明此场景下应当如何处理，作为回放与后续判定的样本。"
                />
              </Field>
              <Field label="期望动作">
                <Select
                  value={feedbackExpectedAction}
                  onChange={e =>
                    setFeedbackExpectedAction(e.target.value as 'silent' | 'reply' | 'act' | '')
                  }
                >
                  <option value="">不改变动作分类</option>
                  <option value="silent">应当静默</option>
                  <option value="reply">应当回复</option>
                  <option value="act">应当执行动作</option>
                </Select>
              </Field>
              {feedbackError && <Banner tone="danger">{feedbackError}</Banner>}
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={() => setFeedbackDecision(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={!feedbackCorrection.trim()}
                loading={addFeedbackMutation.isPending}
                onClick={() =>
                  feedbackDecision &&
                  addFeedbackMutation.mutate({
                    decisionId: feedbackDecision.id,
                    correction: feedbackCorrection.trim(),
                    expectedAction: feedbackExpectedAction || undefined
                  })
                }
              >
                提交纠正
              </Button>
            </Dialog.Footer>
          </Dialog>
        </div>
      )}
    </div>
  );
}

/**
 * 按 scope 隔离的顶层组件：切换群或 Bot 时用 key 重建内部 panel，
 * query 缓存、表单草稿、对话框状态互不串联。
 */
export function CollaborationPanel(props: CollaborationPanelProps) {
  return <CollaborationPanelInner key={`${props.appId}:${props.chatId}`} {...props} />;
}
