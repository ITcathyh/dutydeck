import { describe, expect, it } from 'vitest';
import {
  beginActionInputSchema,
  collaborationActionSchema,
  collaborationActivitySchema,
  collaborationBootstrapSchema,
  collaborationDecisionSchema,
  collaborationFeedbackSchema,
  collaborationFollowupSchema,
  collaborationFollowupStepSchema,
  collaborationMandateSchema,
  collaborationObservationSchema,
  collaborationScopeSchema,
  collaborationSettingsSchema,
  collaborationSnapshotSchema,
  collaborationTeamContextSchema,
  createFeedbackInputSchema,
  createFollowupInputSchema,
  createMandateInputSchema,
  listObservationsOptionsSchema,
  observeCollaborationInputSchema,
  updateActionInputSchema,
  updateCollaborationSettingsInputSchema,
  updateDecisionInputSchema,
  updateFollowupInputSchema,
  updateMandateInputSchema,
  validateJsonPayload,
  MAX_JSON_PAYLOAD_BYTES
} from './collaboration.js';

describe('Collaboration Shared Schemas', () => {
  const validScope = { appId: 'cli_123', chatId: 'oc_456' };
  const validIso = '2026-09-18T12:00:00.000Z';

  it('validates team source metadata and rejects malformed retrieval envelopes', () => {
    const source = { scope: validScope, name: '团队群', status: 'complete', missing: [] };
    const team = { query: '个人待办', searchedAt: validIso, sources: [source], observations: [] };
    expect(collaborationTeamContextSchema.parse(team)).toEqual(team);
    for (const patch of [{ query: 'x'.repeat(2001) }, { searchedAt: 'today' }, { extra: true },
      { sources: [{ ...source, name: 'x'.repeat(257) }] }, { sources: [{ ...source, missing: Array(101).fill('gap') }] },
      { sources: [{ ...source, status: 'invented' }] }]) {
      expect(collaborationTeamContextSchema.safeParse({ ...team, ...patch }).success).toBe(false);
    }
  });

  describe('CollaborationScope', () => {
    it('accepts valid scope and rejects unknown fields or empty strings', () => {
      expect(collaborationScopeSchema.parse(validScope)).toEqual(validScope);
      expect(() => collaborationScopeSchema.parse({ ...validScope, extra: 'forbidden' })).toThrow();
      expect(() => collaborationScopeSchema.parse({ appId: '', chatId: 'oc_456' })).toThrow();
      expect(() => collaborationScopeSchema.parse({ appId: 'cli_123', chatId: '   ' })).toThrow();
    });
  });

  describe('CollaborationSettings & Update', () => {
    it('validates settings defaults, boundaries, and rejects invalid values', () => {
      const parsed = collaborationSettingsSchema.parse({
        scope: validScope,
        updatedAt: validIso
      });
      expect(parsed.revision).toBe(0);
      expect(parsed.participation).toBe('off');
      expect(parsed.inheritParticipation).toBe(false);
      expect(parsed.instructions).toBe('');
      expect(parsed.notificationsPaused).toBe(false);
      expect(parsed.maxProactivePerHour).toBe(6);
      expect(parsed.retentionDays).toBe(30);
      expect(parsed.policyVersion).toBe('v1');

      // maxProactivePerHour bounded to 0..60
      expect(() =>
        collaborationSettingsSchema.parse({
          scope: validScope,
          maxProactivePerHour: 61,
          updatedAt: validIso
        })
      ).toThrow();
      expect(() =>
        collaborationSettingsSchema.parse({
          scope: validScope,
          maxProactivePerHour: -1,
          updatedAt: validIso
        })
      ).toThrow();

      // retentionDays bounded to 1..365
      expect(() =>
        collaborationSettingsSchema.parse({
          scope: validScope,
          retentionDays: 0,
          updatedAt: validIso
        })
      ).toThrow();
      expect(() =>
        collaborationSettingsSchema.parse({
          scope: validScope,
          retentionDays: 366,
          updatedAt: validIso
        })
      ).toThrow();

      // instructions max length 8000
      expect(() =>
        collaborationSettingsSchema.parse({
          scope: validScope,
          instructions: 'a'.repeat(8001),
          updatedAt: validIso
        })
      ).toThrow();

      // strict mode
      expect(() =>
        collaborationSettingsSchema.parse({
          scope: validScope,
          unknownField: true,
          updatedAt: validIso
        })
      ).toThrow();
    });

    it('accepts restoring inheritance without a participation override', () => {
      expect(updateCollaborationSettingsInputSchema.parse({ expectedRevision: 1, inheritParticipation: true }))
        .toEqual({ expectedRevision: 1, inheritParticipation: true });
      expect(() => updateCollaborationSettingsInputSchema.parse({ expectedRevision: 1, inheritParticipation: 'true' })).toThrow();
    });

    it('validates update settings patch schema requires at least one updated field and expectedRevision', () => {
      expect(() => updateCollaborationSettingsInputSchema.parse({ expectedRevision: 0 })).toThrow(
        /At least one field must be updated/
      );
      const validPatch = updateCollaborationSettingsInputSchema.parse({
        expectedRevision: 0,
        participation: 'observe',
        maxProactivePerHour: 10
      });
      expect(validPatch.participation).toBe('observe');
      expect(validPatch.maxProactivePerHour).toBe(10);

      // Unknown fields rejected
      expect(() =>
        updateCollaborationSettingsInputSchema.parse({
          expectedRevision: 0,
          participation: 'observe',
          invalidField: 123
        })
      ).toThrow();
    });
  });

  describe('CollaborationObservation & Inputs', () => {
    it('validates observation fields, origins, text limit, and strictness', () => {
      const validObs = {
        id: 'obs_1',
        scope: validScope,
        sequence: 1,
        source: 'lark',
        eventId: 'evt_100',
        occurredAt: validIso,
        receivedAt: validIso,
        senderId: 'ou_human',
        senderKind: 'human',
        text: 'hello',
        refs: ['msg_1'],
        origin: 'live',
        missing: [],
        revision: 1
      };
      expect(collaborationObservationSchema.parse(validObs)).toEqual(validObs);

      // Text max length 16000
      expect(() =>
        collaborationObservationSchema.parse({
          ...validObs,
          text: 'a'.repeat(16001)
        })
      ).toThrow();

      // Sequence must be >= 1
      expect(() =>
        collaborationObservationSchema.parse({
          ...validObs,
          sequence: 0
        })
      ).toThrow();

      // Invalid date rejected
      expect(() =>
        collaborationObservationSchema.parse({
          ...validObs,
          occurredAt: 'invalid-date'
        })
      ).toThrow();
    });

    it('validates observe input and list options', () => {
      const input = {
        scope: validScope,
        source: 'lark',
        eventId: 'evt_101',
        occurredAt: validIso,
        receivedAt: validIso,
        senderKind: 'bot',
        text: 'bot message',
        origin: 'history'
      };
      const parsed = observeCollaborationInputSchema.parse(input);
      expect(parsed.refs).toEqual([]);
      expect(parsed.missing).toEqual([]);

      const options = listObservationsOptionsSchema.parse({ limit: 50, afterSequence: 10 });
      expect(options.limit).toBe(50);
      expect(options.afterSequence).toBe(10);
      expect(() => listObservationsOptionsSchema.parse({ limit: 0 })).toThrow();
      expect(() => listObservationsOptionsSchema.parse({ extra: true })).toThrow();
    });
  });

  describe('CollaborationBootstrap', () => {
    it('validates bootstrap status and strict schema', () => {
      const bootstrap = {
        scope: validScope,
        status: 'partial',
        cursor: 'cur_abc',
        lastEventAt: validIso,
        missing: ['part_1'],
        updatedAt: validIso
      };
      expect(collaborationBootstrapSchema.parse(bootstrap)).toEqual(bootstrap);
      expect(() => collaborationBootstrapSchema.parse({ ...bootstrap, status: 'invalid_status' })).toThrow();
    });
  });

  describe('CollaborationFollowup & Inputs', () => {
    it('validates followup steps and status', () => {
      const step = collaborationFollowupStepSchema.parse({
        id: 'step_1',
        label: 'First step',
        status: 'open'
      });
      expect(step.status).toBe('open');

      const createInput = createFollowupInputSchema.parse({
        scope: validScope,
        goal: 'Complete migration',
        createdBy: 'ou_admin',
        steps: [step]
      });
      expect(createInput.status).toBe('open');
      expect(createInput.provenance).toBe('observed');

      const followup = collaborationFollowupSchema.parse({
        id: 'fol_1',
        scope: validScope,
        revision: 1,
        goal: 'Complete migration',
        status: 'open',
        progress: 'in progress',
        steps: [step],
        sourceRefs: [],
        taskIds: [],
        externalRefs: [],
        fields: {},
        createdBy: 'ou_admin',
        updatedBy: 'ou_admin',
        provenance: 'confirmed',
        createdAt: validIso,
        updatedAt: validIso
      });
      expect(followup.id).toBe('fol_1');

      // Update patch allows nullable for optional fields to clear them
      const updatePatch = updateFollowupInputSchema.parse({
        expectedRevision: 1,
        dueAt: null,
        result: null,
        ownerId: null
      });
      expect(updatePatch.dueAt).toBeNull();
      expect(updatePatch.result).toBeNull();

      expect(() => updateFollowupInputSchema.parse({ expectedRevision: 1 })).toThrow(
        /At least one field must be updated/
      );
    });

    it('enforces maximum 50 entries for followup fields', () => {
      const validFields: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        validFields[`k_${i}`] = `v_${i}`;
      }
      expect(
        createFollowupInputSchema.parse({
          scope: validScope,
          goal: 'Valid fields',
          createdBy: 'alice',
          fields: validFields
        }).fields
      ).toEqual(validFields);

      const excessFields = { ...validFields, k_extra: 'overflow' };
      expect(() =>
        createFollowupInputSchema.parse({
          scope: validScope,
          goal: 'Excess fields',
          createdBy: 'alice',
          fields: excessFields
        })
      ).toThrow(/Fields must contain at most 50 entries/);

      expect(() =>
        updateFollowupInputSchema.parse({
          expectedRevision: 1,
          fields: excessFields
        })
      ).toThrow(/Fields must contain at most 50 entries/);
    });
  });

  describe('CollaborationMandate & Inputs', () => {
    it('validates mandate modes, conditions, catchup policies and updates', () => {
      const createInput = createMandateInputSchema.parse({
        scope: validScope,
        goal: 'Daily sync',
        requesterId: 'ou_boss',
        scheduleDefinitionId: 'sched_1',
        mode: 'notify',
        prompt: 'Notify if open'
      });
      expect(createInput.status).toBe('active');
      expect(createInput.condition).toBe('always');
      expect(createInput.catchupPolicy).toBe('skip');

      const mandate = collaborationMandateSchema.parse({
        id: 'man_1',
        scope: validScope,
        revision: 1,
        goal: 'Daily sync',
        status: 'active',
        requesterId: 'ou_boss',
        sourceRefs: [],
        scheduleDefinitionId: 'sched_1',
        mode: 'agent',
        prompt: 'Run followups',
        condition: 'followup_open',
        deliveryPaused: false,
        catchupPolicy: 'coalesce',
        createdAt: validIso,
        updatedAt: validIso
      });
      expect(mandate.mode).toBe('agent');
      expect(mandate.condition).toBe('followup_open');

      const updatePatch = updateMandateInputSchema.parse({
        expectedRevision: 1,
        followupId: null,
        lastProgressRevision: null
      });
      expect(updatePatch.followupId).toBeNull();

      expect(() => updateMandateInputSchema.parse({ expectedRevision: 1 })).toThrow(
        /At least one field must be updated/
      );
    });
  });

  describe('CollaborationDecision & Feedback', () => {
    it('validates decision and feedback schemas', () => {
      const decision = collaborationDecisionSchema.parse({
        id: 'dec_1',
        scope: validScope,
        contextRevision: 5,
        policyVersion: 'v1',
        action: 'reply',
        reason: 'Authorized task query',
        evidenceIds: ['obs_1'],
        status: 'sent',
        response: 'Task created',
        inputSnapshot: { query: 'status' },
        createdAt: validIso
      });
      expect(decision.action).toBe('reply');

      const updateDecision = updateDecisionInputSchema.parse({
        status: 'failed',
        response: null
      });
      expect(updateDecision.status).toBe('failed');

      const feedback = collaborationFeedbackSchema.parse({
        id: 'fb_1',
        scope: validScope,
        decisionId: 'dec_1',
        actorId: 'ou_user',
        correction: 'Should have remained silent',
        expectedAction: 'silent',
        createdAt: validIso
      });
      expect(feedback.expectedAction).toBe('silent');

      const feedbackInput = createFeedbackInputSchema.parse({
        scope: validScope,
        decisionId: 'dec_1',
        actorId: 'ou_user',
        correction: 'Correction text'
      });
      expect(feedbackInput.correction).toBe('Correction text');
    });

    it('rejects oversized inputSnapshot (>1MiB) or circular references in decision', () => {
      // 300KiB is under 1MiB and must be accepted (payload/snapshot share the 1MiB ceiling)
      const underCeiling = { large: 'x'.repeat(300 * 1024) };
      expect(() =>
        collaborationDecisionSchema.parse({
          id: 'dec_under',
          scope: validScope,
          contextRevision: 1,
          policyVersion: 'v1',
          action: 'reply',
          reason: 'Under ceiling',
          status: 'sent',
          inputSnapshot: underCeiling,
          createdAt: validIso
        })
      ).not.toThrow();

      // Oversized > 1MiB
      const oversizedSnapshot = { large: 'x'.repeat(MAX_JSON_PAYLOAD_BYTES + 1024) };
      expect(() =>
        collaborationDecisionSchema.parse({
          id: 'dec_oversized',
          scope: validScope,
          contextRevision: 1,
          policyVersion: 'v1',
          action: 'reply',
          reason: 'Oversized',
          status: 'sent',
          inputSnapshot: oversizedSnapshot,
          createdAt: validIso
        })
      ).toThrow(/1MiB/);

      // Circular references rejected
      const circularObj: Record<string, unknown> = {};
      circularObj.self = circularObj;
      expect(() =>
        collaborationDecisionSchema.parse({
          id: 'dec_circular',
          scope: validScope,
          contextRevision: 1,
          policyVersion: 'v1',
          action: 'reply',
          reason: 'Circular',
          status: 'sent',
          inputSnapshot: circularObj,
          createdAt: validIso
        })
      ).toThrow();
    });

    it('strict JSON validation rejects NaN/Infinity/functions/symbols/bigints/non-JSON objects and array undefined', () => {
      // Primitives and well-formed JSON pass
      expect(validateJsonPayload({ a: 1, b: 'x', c: true, d: null, e: [1, 'two', false, null] })).toBe(true);
      // Optional undefined object field is omitted, not rejected
      expect(validateJsonPayload({ keep: 1, omit: undefined })).toBe(true);
      // Nested undefined object field is omitted
      expect(validateJsonPayload({ outer: { keep: 1, omit: undefined } })).toBe(true);

      // NaN / Infinity are silently coerced by bare JSON.stringify; must be rejected
      expect(validateJsonPayload({ v: Number.NaN })).toBe(false);
      expect(validateJsonPayload({ v: Number.POSITIVE_INFINITY })).toBe(false);
      expect(validateJsonPayload({ nested: { v: Number.NaN } })).toBe(false);

      // Functions, symbols, bigints rejected (including nested)
      expect(validateJsonPayload({ fn: () => 1 })).toBe(false);
      expect(validateJsonPayload({ nested: { fn: () => 1 } })).toBe(false);
      expect(validateJsonPayload({ sym: Symbol('s') })).toBe(false);
      expect(validateJsonPayload({ bg: 10n })).toBe(false);

      // Non-JSON objects rejected
      expect(validateJsonPayload({ when: new Date('2026-09-18') })).toBe(false);
      expect(validateJsonPayload({ m: new Map([['k', 'v']]) })).toBe(false);
      expect(validateJsonPayload({ nested: { d: new Date() } })).toBe(false);
      class Custom { x = 1; }
      expect(validateJsonPayload({ c: new Custom() })).toBe(false);

      // undefined inside an array is rejected (cannot be faithfully represented)
      expect(validateJsonPayload({ arr: [1, undefined, 2] })).toBe(false);
      expect(validateJsonPayload([1, undefined])).toBe(false);
      expect(validateJsonPayload({ nested: { arr: [undefined] } })).toBe(false);

      // Circular reference rejected
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(validateJsonPayload(circular)).toBe(false);
      const nestedCircular: Record<string, unknown> = { outer: {} };
      (nestedCircular.outer as Record<string, unknown>).back = nestedCircular;
      expect(validateJsonPayload(nestedCircular)).toBe(false);

      // Top-level non-object/non-JSON rejected
      expect(validateJsonPayload(undefined)).toBe(false);
      expect(validateJsonPayload(() => 1)).toBe(false);
    });
  });

  describe('CollaborationAction & Inputs', () => {
    it('validates action lifecycle and beginAction / updateAction schemas', () => {
      const action = collaborationActionSchema.parse({
        id: 'act_1',
        scope: validScope,
        revision: 1,
        kind: 'send_lark_message',
        requesterId: 'ou_user',
        inputDigest: 'digest_123',
        payload: { text: 'hi' },
        status: 'intent',
        createdAt: validIso,
        updatedAt: validIso
      });
      expect(action.status).toBe('intent');

      const beginInput = beginActionInputSchema.parse({
        id: 'act_2',
        scope: validScope,
        kind: 'dispatch_agent',
        requesterId: 'ou_user',
        inputDigest: 'digest_456'
      });
      expect(beginInput.payload).toEqual({});

      const updateInput = updateActionInputSchema.parse({
        expectedRevision: 1,
        status: 'sending',
        receipt: 'rec_001'
      });
      expect(updateInput.status).toBe('sending');

      expect(() =>
        updateActionInputSchema.parse({
          expectedRevision: 0,
          status: 'sending'
        })
      ).toThrow();
    });

    it('rejects oversized payload (>1MiB), circular/non-JSON references in beginAction', () => {
      // 300KiB snapshot-bearing payload is under the shared 1MiB ceiling and must pass
      const underCeiling = { snapshot: { text: 'x'.repeat(300 * 1024) }, note: 'dispatch' };
      expect(() =>
        beginActionInputSchema.parse({
          id: 'act_under',
          scope: validScope,
          kind: 'remote_call',
          requesterId: 'ou_user',
          inputDigest: 'digest_0',
          payload: underCeiling
        })
      ).not.toThrow();

      const oversizedPayload = { data: 'y'.repeat(MAX_JSON_PAYLOAD_BYTES + 1024) };
      expect(() =>
        beginActionInputSchema.parse({
          id: 'act_oversized',
          scope: validScope,
          kind: 'remote_call',
          requesterId: 'ou_user',
          inputDigest: 'digest_1',
          payload: oversizedPayload
        })
      ).toThrow(/1MiB/);

      const circularObj: Record<string, unknown> = {};
      circularObj.ref = circularObj;
      expect(() =>
        beginActionInputSchema.parse({
          id: 'act_circular',
          scope: validScope,
          kind: 'remote_call',
          requesterId: 'ou_user',
          inputDigest: 'digest_2',
          payload: circularObj
        })
      ).toThrow();

      // Nested non-finite number and non-JSON object rejected at the action boundary
      expect(() =>
        beginActionInputSchema.parse({
          id: 'act_nan',
          scope: validScope,
          kind: 'remote_call',
          requesterId: 'ou_user',
          inputDigest: 'digest_3',
          payload: { stats: { ratio: Number.NaN } }
        })
      ).toThrow();
      expect(() =>
        beginActionInputSchema.parse({
          id: 'act_date',
          scope: validScope,
          kind: 'remote_call',
          requesterId: 'ou_user',
          inputDigest: 'digest_4',
          payload: { at: new Date('2026-09-18') }
        })
      ).toThrow();
    });
  });

  describe('CollaborationActivity & Snapshot', () => {
    it('validates activity and snapshot composite schema', () => {
      const activity = collaborationActivitySchema.parse({
        id: 'actv_1',
        scope: validScope,
        entityKind: 'followup',
        entityId: 'fol_1',
        revision: 1,
        actorId: 'ou_user',
        sourceRefs: [],
        provenance: 'confirmed',
        summary: 'Created followup',
        createdAt: validIso
      });
      expect(activity.entityKind).toBe('followup');

      const snapshot = collaborationSnapshotSchema.parse({
        scope: validScope,
        contextRevision: 3,
        settings: {
          scope: validScope,
          revision: 1,
          participation: 'observe',
          instructions: 'Be helpful',
          notificationsPaused: false,
          maxProactivePerHour: 5,
          retentionDays: 14,
          policyVersion: 'v1',
          updatedAt: validIso
        },
        observations: [],
        followups: [],
        mandates: []
      });
      expect(snapshot.contextRevision).toBe(3);
      expect(snapshot.observations).toEqual([]);
    });

    it('snapshot is an unbounded read window: accumulated material over 1MiB still parses', () => {
      // 70 observations with 16k text each ~ 1.1MiB. The snapshot schema is an internal
      // read window, NOT a persisted bounded JSON entry, so it must not be size-rejected.
      const largeObservations = Array.from({ length: 70 }, (_, i) => ({
        id: `obs_${i}`,
        scope: validScope,
        sequence: i + 1,
        source: 'lark',
        eventId: `evt_${i}`,
        occurredAt: validIso,
        receivedAt: validIso,
        senderKind: 'human' as const,
        text: 'z'.repeat(16000),
        refs: [],
        origin: 'live' as const,
        missing: [],
        revision: 1
      }));

      const largeSnapshot = collaborationSnapshotSchema.parse({
        scope: validScope,
        contextRevision: 70,
        settings: {
          scope: validScope,
          revision: 1,
          participation: 'observe',
          instructions: '',
          notificationsPaused: false,
          maxProactivePerHour: 5,
          retentionDays: 14,
          policyVersion: 'v1',
          updatedAt: validIso
        },
        observations: largeObservations,
        followups: [],
        mandates: []
      });
      expect(largeSnapshot.observations.length).toBe(70);
      expect(largeSnapshot.contextRevision).toBe(70);
    });
  });
});
