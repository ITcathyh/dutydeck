import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeError } from '@dutydeck/shared';
import { createRepositories } from './index.js';

describe('Collaboration Storage Repository', () => {
  const scopeA = { appId: 'cli_app_a', chatId: 'oc_chat_a' };
  const scopeB = { appId: 'cli_app_b', chatId: 'oc_chat_b' };
  const isoTime1 = '2026-09-18T10:00:00.000Z';
  const isoTime2 = '2026-09-18T11:00:00.000Z';
  const isoTime3 = '2026-09-18T12:00:00.000Z';

  it('runs SQLite migrations cleanly in memory and creates collaboration tables', () => {
    const repos = createRepositories(':memory:');
    try {
      expect(repos.collaboration).toBeDefined();
      expect(typeof repos.collaboration.getSettings).toBe('function');
      expect(typeof repos.collaboration.observe).toBe('function');
    } finally {
      repos.close();
    }
  });

  describe('Settings & ContextRevision & Scope Isolation', () => {
    it('initializes default settings with revision 0, and updates with CAS and activity logging', async () => {
      const repos = createRepositories(':memory:');
      try {
        const collab = repos.collaboration;
        const initial = await collab.getSettings(scopeA);
        expect(initial.revision).toBe(0);
        expect(initial.participation).toBe('off');
        expect(initial.instructions).toBe('');
        expect(initial.notificationsPaused).toBe(false);

        // CAS conflict when expectedRevision mismatch
        await expect(
          collab.updateSettings(scopeA, { expectedRevision: 1, participation: 'observe' }, 'actor_1')
        ).rejects.toThrow(RuntimeError);

        // Successful update with expectedRevision: 0
        const updated = await collab.updateSettings(
          scopeA,
          {
            expectedRevision: 0,
            participation: 'observe',
            instructions: 'Always be concise',
            maxProactivePerHour: 10
          },
          'actor_1'
        );
        expect(updated.revision).toBe(1);
        expect(updated.participation).toBe('observe');
        expect(updated.instructions).toBe('Always be concise');
        expect(updated.maxProactivePerHour).toBe(10);

        // Check activity logged
        const activities = await collab.listActivities(scopeA);
        expect(activities.length).toBe(1);
        expect(activities[0].entityKind).toBe('settings');
        expect(activities[0].revision).toBe(1);
        expect(activities[0].actorId).toBe('actor_1');

        // Check contextRevision advanced
        const snap = await collab.snapshot(scopeA);
        expect(snap.contextRevision).toBe(1);

        // Scope isolation: scopeB still has default settings and contextRevision 0
        const settingsB = await collab.getSettings(scopeB);
        expect(settingsB.revision).toBe(0);
        const snapB = await collab.snapshot(scopeB);
        expect(snapB.contextRevision).toBe(0);
      } finally {
        repos.close();
      }
    });
  });

  describe('Observation Deduplication, Revision Edit, and Pruning Retention', () => {
    it('deduplicates identical observation without advancing sequence or contextRevision', async () => {
      const repos = createRepositories(':memory:');
      try {
        const collab = repos.collaboration;

        // First observe: new observation created
        const first = await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_001',
          occurredAt: isoTime1,
          receivedAt: isoTime1,
          senderId: 'user_1',
          senderKind: 'human',
          text: 'Need help with deployment',
          origin: 'live'
        });
        expect(first.created).toBe(true);
        expect(first.changed).toBe(true);
        expect(first.observation.sequence).toBe(1);
        expect(first.observation.revision).toBe(1);
        expect(first.contextRevision).toBe(1);

        // Duplicate identical observe: returns existing without advancing sequence or contextRevision
        const duplicate = await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_001',
          occurredAt: isoTime1,
          receivedAt: isoTime1,
          senderId: 'user_1',
          senderKind: 'human',
          text: 'Need help with deployment',
          origin: 'live'
        });
        expect(duplicate.created).toBe(false);
        expect(duplicate.changed).toBe(false);
        expect(duplicate.observation.sequence).toBe(1);
        expect(duplicate.observation.revision).toBe(1);
        expect(duplicate.contextRevision).toBe(1);

        // Delivery with only receivedAt different does NOT increment sequence or contextRevision
        const duplicateDifferentReceivedAt = await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_001',
          occurredAt: isoTime1,
          receivedAt: isoTime2, // different receivedAt
          senderId: 'user_1',
          senderKind: 'human',
          text: 'Need help with deployment',
          origin: 'live'
        });
        expect(duplicateDifferentReceivedAt.created).toBe(false);
        expect(duplicateDifferentReceivedAt.changed).toBe(false);
        expect(duplicateDifferentReceivedAt.observation.sequence).toBe(1);
        expect(duplicateDifferentReceivedAt.contextRevision).toBe(1);

        // Edited observation with same eventId but modified text: advances revision AND sequence/contextRevision
        const edited = await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_001',
          occurredAt: isoTime1,
          receivedAt: isoTime2,
          senderId: 'user_1',
          senderKind: 'human',
          text: 'Need help with deployment to staging cluster',
          origin: 'live'
        });
        expect(edited.created).toBe(false);
        expect(edited.changed).toBe(true);
        expect(edited.observation.sequence).toBe(2);
        expect(edited.observation.revision).toBe(2);
        expect(edited.observation.text).toBe('Need help with deployment to staging cluster');
        expect(edited.contextRevision).toBe(2);

        // A new second observation: sequence is 3, contextRevision is 3
        const second = await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_002',
          occurredAt: isoTime2,
          receivedAt: isoTime2,
          senderId: 'user_2',
          senderKind: 'human',
          text: 'I can help look into that',
          origin: 'live'
        });
        expect(second.created).toBe(true);
        expect(second.observation.sequence).toBe(3);
        expect(second.contextRevision).toBe(3);

        // List observations respects updated sequence ordering and options
        const listAll = await collab.listObservations(scopeA);
        expect(listAll.length).toBe(2);
        expect(listAll[0].sequence).toBe(2); // evt_001 edited
        expect(listAll[1].sequence).toBe(3); // evt_002 new

        const listAfter = await collab.listObservations(scopeA, { afterSequence: 2 });
        expect(listAfter.length).toBe(1);
        expect(listAfter[0].sequence).toBe(3);
      } finally {
        repos.close();
      }
    });

    it('adds 30 observations, edits the first, verifies afterSequence and snapshot(limit 1) and file reopen', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'collab-edit-seq-test-'));
      const dbPath = join(testDir, 'test.db');

      try {
        let repos = createRepositories(dbPath);
        const collab = repos.collaboration;

        // Add 30 observations
        for (let i = 1; i <= 30; i++) {
          await collab.observe({
            scope: scopeA,
            source: 'lark',
            eventId: `evt_${String(i).padStart(3, '0')}`,
            occurredAt: `2026-09-18T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
            receivedAt: isoTime1,
            senderKind: 'human',
            text: `Message ${i}`,
            origin: 'live'
          });
        }

        const snapBefore = await collab.snapshot(scopeA);
        expect(snapBefore.contextRevision).toBe(30);
        expect(snapBefore.observations.length).toBe(30);

        // Now edit the first observation (evt_001)
        const editedFirst = await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_001',
          occurredAt: '2026-09-18T10:00:01.000Z',
          receivedAt: isoTime2,
          senderKind: 'human',
          text: 'Edited Message 1',
          origin: 'live'
        });
        expect(editedFirst.created).toBe(false);
        expect(editedFirst.changed).toBe(true);
        expect(editedFirst.observation.sequence).toBe(31);
        expect(editedFirst.contextRevision).toBe(31);

        // listObservations with afterSequence: 30 MUST yield the edited first message!
        const afterThirty = await collab.listObservations(scopeA, { afterSequence: 30 });
        expect(afterThirty.length).toBe(1);
        expect(afterThirty[0].eventId).toBe('evt_001');
        expect(afterThirty[0].text).toBe('Edited Message 1');
        expect(afterThirty[0].sequence).toBe(31);

        // snapshot(limit 1) MUST show the edited message as latest material
        const snapLimitOne = await collab.snapshot(scopeA, 1);
        expect(snapLimitOne.observations.length).toBe(1);
        expect(snapLimitOne.observations[0].eventId).toBe('evt_001');
        expect(snapLimitOne.observations[0].text).toBe('Edited Message 1');
        expect(snapLimitOne.contextRevision).toBe(31);

        // Close and reopen to verify persistence
        repos.close();
        repos = createRepositories(dbPath);
        const reloaded = repos.collaboration;

        const reloadedAfterThirty = await reloaded.listObservations(scopeA, { afterSequence: 30 });
        expect(reloadedAfterThirty.length).toBe(1);
        expect(reloadedAfterThirty[0].eventId).toBe('evt_001');
        expect(reloadedAfterThirty[0].sequence).toBe(31);

        const reloadedSnapOne = await reloaded.snapshot(scopeA, 1);
        expect(reloadedSnapOne.observations[0].eventId).toBe('evt_001');
        expect(reloadedSnapOne.observations[0].sequence).toBe(31);

        repos.close();
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('history backfill of an existing live observation returns it atomically unchanged, while genuine live edits still advance', async () => {
      const repos = createRepositories(':memory:');
      try {
        const collab = repos.collaboration;

        // 1. Initial live observation with real-time explicit ref
        const liveObs = await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_history_guard',
          occurredAt: isoTime1,
          receivedAt: isoTime1,
          senderId: 'live_sender',
          senderKind: 'human',
          text: 'Original live message',
          refs: ['msg_ref_1', 'dutydeck:explicit:instruction_1'],
          origin: 'live'
        });
        expect(liveObs.observation.origin).toBe('live');
        expect(liveObs.observation.refs).toContain('dutydeck:explicit:instruction_1');
        expect(liveObs.observation.sequence).toBe(1);
        expect(liveObs.contextRevision).toBe(1);

        // 2. History re-read with identical content: unchanged, no advance
        const historyNoChange = await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_history_guard',
          occurredAt: isoTime1,
          receivedAt: isoTime2,
          senderId: 'live_sender',
          senderKind: 'human',
          text: 'Original live message',
          refs: ['msg_ref_1', 'dutydeck:explicit:instruction_1'],
          origin: 'history'
        });
        expect(historyNoChange.created).toBe(false);
        expect(historyNoChange.changed).toBe(false);
        expect(historyNoChange.observation.origin).toBe('live');
        expect(historyNoChange.observation.sequence).toBe(1);
        expect(historyNoChange.contextRevision).toBe(1);

        // 3. History re-read carrying STALE data (different text/identity/refs) must NOT overwrite
        //    the newer live row. It returns the existing live observation unchanged, no advance.
        const historyStale = await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_history_guard',
          occurredAt: isoTime1,
          receivedAt: isoTime3,
          senderId: 'stale_history_sender',
          senderKind: 'bot',
          text: 'Stale text that must not overwrite live',
          refs: ['stale_ref'],
          origin: 'history'
        });
        expect(historyStale.created).toBe(false);
        expect(historyStale.changed).toBe(false);
        expect(historyStale.observation.text).toBe('Original live message');
        expect(historyStale.observation.senderId).toBe('live_sender');
        expect(historyStale.observation.senderKind).toBe('human');
        expect(historyStale.observation.origin).toBe('live');
        expect(historyStale.observation.refs).toContain('dutydeck:explicit:instruction_1');
        expect(historyStale.observation.refs).not.toContain('stale_ref');
        expect(historyStale.observation.sequence).toBe(1);
        expect(historyStale.observation.revision).toBe(1);
        expect(historyStale.contextRevision).toBe(1);

        // 4. A genuine LIVE edit of the same source/eventId still advances revision and sequence.
        const liveEdit = await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_history_guard',
          occurredAt: isoTime1,
          receivedAt: isoTime3,
          senderId: 'live_sender',
          senderKind: 'human',
          text: 'Genuinely edited live message',
          refs: ['msg_ref_1', 'dutydeck:explicit:instruction_1'],
          origin: 'live'
        });
        expect(liveEdit.created).toBe(false);
        expect(liveEdit.changed).toBe(true);
        expect(liveEdit.observation.text).toBe('Genuinely edited live message');
        expect(liveEdit.observation.origin).toBe('live');
        expect(liveEdit.observation.sequence).toBe(2);
        expect(liveEdit.observation.revision).toBe(2);
        expect(liveEdit.contextRevision).toBe(2);
      } finally {
        repos.close();
      }
    });

    it('pruning observations deletes old rows while monotonic sequence and contextRevision persist', async () => {
      const repos = createRepositories(':memory:');
      try {
        const collab = repos.collaboration;

        await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_old',
          occurredAt: '2026-08-01T00:00:00.000Z',
          receivedAt: '2026-08-01T00:00:00.000Z',
          senderKind: 'human',
          text: 'old message',
          origin: 'live'
        });
        await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_new',
          occurredAt: '2026-09-18T00:00:00.000Z',
          receivedAt: '2026-09-18T00:00:00.000Z',
          senderKind: 'human',
          text: 'new message',
          origin: 'live'
        });

        // Current sequence is 2, contextRevision is 2
        const beforeSnap = await collab.snapshot(scopeA);
        expect(beforeSnap.contextRevision).toBe(2);
        expect(beforeSnap.observations.length).toBe(2);

        // Prune before September 2026
        const prunedCount = await collab.pruneObservations('2026-09-01T00:00:00.000Z');
        expect(prunedCount).toBe(1);

        // Remaining observation is only the new one
        const afterSnap = await collab.snapshot(scopeA);
        expect(afterSnap.observations.length).toBe(1);
        expect(afterSnap.observations[0].eventId).toBe('evt_new');
        // contextRevision does NOT regress
        expect(afterSnap.contextRevision).toBe(2);

        // Next observation continues monotonically from sequence 3
        const third = await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_next',
          occurredAt: '2026-09-18T01:00:00.000Z',
          receivedAt: '2026-09-18T01:00:00.000Z',
          senderKind: 'human',
          text: 'third message',
          origin: 'live'
        });
        expect(third.observation.sequence).toBe(3);
        expect(third.contextRevision).toBe(3);
      } finally {
        repos.close();
      }
    });

    it('pruning observations supports optional scope parameter for per-group retention isolation', async () => {
      const repos = createRepositories(':memory:');
      try {
        const collab = repos.collaboration;

        // Add old message for scopeA and scopeB
        await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_a_old',
          occurredAt: '2026-08-01T00:00:00.000Z',
          receivedAt: '2026-08-01T00:00:00.000Z',
          senderKind: 'human',
          text: 'old message in scopeA',
          origin: 'live'
        });
        await collab.observe({
          scope: scopeB,
          source: 'lark',
          eventId: 'evt_b_old',
          occurredAt: '2026-08-01T00:00:00.000Z',
          receivedAt: '2026-08-01T00:00:00.000Z',
          senderKind: 'human',
          text: 'old message in scopeB',
          origin: 'live'
        });

        // Pruning with scopeA ONLY removes scopeA's old observation
        const prunedA = await collab.pruneObservations('2026-09-01T00:00:00.000Z', scopeA);
        expect(prunedA).toBe(1);

        const obsA = await collab.listObservations(scopeA);
        expect(obsA.length).toBe(0);

        // scopeB's observation MUST still exist!
        const obsB = await collab.listObservations(scopeB);
        expect(obsB.length).toBe(1);
        expect(obsB[0].eventId).toBe('evt_b_old');

        // Global pruning without scope removes remaining old observations across all scopes
        const prunedAll = await collab.pruneObservations('2026-09-01T00:00:00.000Z');
        expect(prunedAll).toBe(1);
        const obsBAfter = await collab.listObservations(scopeB);
        expect(obsBAfter.length).toBe(0);
      } finally {
        repos.close();
      }
    });

    it('snapshot read window stays available when a group accumulates more than 1MiB of material', async () => {
      const repos = createRepositories(':memory:');
      try {
        const collab = repos.collaboration;
        // 70 observations x ~16k text > 1MiB of accumulated material.
        for (let i = 0; i < 70; i++) {
          await collab.observe({
            scope: scopeA,
            source: 'lark',
            eventId: `evt_big_${String(i).padStart(3, '0')}`,
            occurredAt: `2026-09-18T11:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
            receivedAt: isoTime1,
            senderKind: 'human',
            text: 'X'.repeat(16000),
            origin: 'live'
          });
        }

        // The full-window snapshot must not throw even though its serialized size exceeds 1MiB.
        const full = await collab.snapshot(scopeA, 500);
        expect(full.observations.length).toBe(70);
        // Default 30-row window still works for GET/scheduler.
        const windowed = await collab.snapshot(scopeA);
        expect(windowed.observations.length).toBe(30);
        expect(windowed.contextRevision).toBe(70);
      } finally {
        repos.close();
      }
    });
  });

  describe('Followups & Mandates & Activities', () => {
    it('creates and updates followup with CAS, activity, and prevents auto-completing on partial/done steps', async () => {
      const repos = createRepositories(':memory:');
      try {
        const collab = repos.collaboration;

        const followup = await collab.createFollowup({
          scope: scopeA,
          goal: 'Investigate memory leak',
          progress: 'Initial triage',
          steps: [
            { id: 's1', label: 'Capture heap dump', status: 'open' },
            { id: 's2', label: 'Analyze top retainers', status: 'open' }
          ],
          createdBy: 'alice'
        });
        expect(followup.revision).toBe(1);
        expect(followup.status).toBe('open');

        // Step 1 completed, status remains 'open'
        const updated1 = await collab.updateFollowup(
          scopeA,
          followup.id,
          {
            expectedRevision: 1,
            steps: [
              { id: 's1', label: 'Capture heap dump', status: 'done' },
              { id: 's2', label: 'Analyze top retainers', status: 'open' }
            ],
            progress: 'Heap dump captured'
          },
          'alice'
        );
        expect(updated1.revision).toBe(2);
        expect(updated1.status).toBe('open');

        // Partial completion or all steps marked done without explicit status patch MUST NOT auto-complete
        const updated2 = await collab.updateFollowup(
          scopeA,
          followup.id,
          {
            expectedRevision: 2,
            steps: [
              { id: 's1', label: 'Capture heap dump', status: 'done' },
              { id: 's2', label: 'Analyze top retainers', status: 'done' }
            ]
          },
          'alice'
        );
        expect(updated2.revision).toBe(3);
        // Requirement: "Followup 步骤部分完成不能自动 completed"
        expect(updated2.status).toBe('open');

        // Explicit status transition to completed
        const updated3 = await collab.updateFollowup(
          scopeA,
          followup.id,
          {
            expectedRevision: 3,
            status: 'completed',
            result: 'Root cause fixed in v1.2'
          },
          'alice'
        );
        expect(updated3.revision).toBe(4);
        expect(updated3.status).toBe('completed');
        expect(updated3.result).toBe('Root cause fixed in v1.2');

        // Scope isolation and 404
        await expect(
          collab.updateFollowup(scopeB, followup.id, { expectedRevision: 4, goal: 'Hacked' }, 'mallory')
        ).rejects.toThrow(RuntimeError);
      } finally {
        repos.close();
      }
    });

    it('creates and updates mandate, verifies followup scope constraint and mandate pausing does not mutate followup', async () => {
      const repos = createRepositories(':memory:');
      try {
        const collab = repos.collaboration;

        const followup = await collab.createFollowup({
          scope: scopeA,
          goal: 'Server migration',
          createdBy: 'bob'
        });

        // Creating mandate with cross-scope followup fails with 404
        await expect(
          collab.createMandate({
            scope: scopeB,
            goal: 'Monitor migration',
            requesterId: 'bob',
            followupId: followup.id,
            scheduleDefinitionId: 'sched_1',
            mode: 'notify',
            prompt: 'Check progress'
          })
        ).rejects.toThrow(RuntimeError);

        // Create mandate in same scope succeeds
        const mandate = await collab.createMandate({
          scope: scopeA,
          goal: 'Monitor migration',
          requesterId: 'bob',
          followupId: followup.id,
          scheduleDefinitionId: 'sched_1',
          mode: 'agent',
          prompt: 'Check progress every hour',
          condition: 'followup_open'
        });
        expect(mandate.revision).toBe(1);
        expect(mandate.status).toBe('active');

        // Pausing mandate MUST NOT mutate the linked followup
        const pausedMandate = await collab.updateMandate(
          scopeA,
          mandate.id,
          {
            expectedRevision: 1,
            status: 'paused',
            deliveryPaused: true
          },
          'bob'
        );
        expect(pausedMandate.revision).toBe(2);
        expect(pausedMandate.status).toBe('paused');
        expect(pausedMandate.deliveryPaused).toBe(true);

        const currentFollowup = await collab.getFollowup(scopeA, followup.id);
        expect(currentFollowup?.status).toBe('open');
        expect(currentFollowup?.revision).toBe(1);

        // Snapshot includes active/paused mandates and open followups
        const snap = await collab.snapshot(scopeA);
        expect(snap.followups.some(f => f.id === followup.id)).toBe(true);
        expect(snap.mandates.some(m => m.id === mandate.id)).toBe(true);
      } finally {
        repos.close();
      }
    });

    it('truncates activity summary to 1000 chars while preserving the full 2000-char goal on all four paths', async () => {
      const repos = createRepositories(':memory:');
      try {
        const collab = repos.collaboration;
        const longGoal = 'G'.repeat(2000);
        const otherLongGoal = 'M'.repeat(2000);

        // Path 1: createFollowup with a 2000-char goal
        const followup = await collab.createFollowup({
          id: 'fol_long',
          scope: scopeA,
          goal: longGoal,
          createdBy: 'alice'
        });
        expect(followup.goal).toHaveLength(2000);

        // Path 2: updateFollowup with a different 2000-char goal
        const updatedFollowup = await collab.updateFollowup(
          scopeA,
          'fol_long',
          { expectedRevision: 1, goal: otherLongGoal },
          'alice'
        );
        expect(updatedFollowup.goal).toHaveLength(2000);
        expect(updatedFollowup.goal[0]).toBe('M');

        // Path 3: createMandate with a 2000-char goal
        const mandate = await collab.createMandate({
          id: 'man_long',
          scope: scopeA,
          goal: longGoal,
          requesterId: 'bob',
          scheduleDefinitionId: 'sched_long',
          mode: 'notify',
          prompt: 'Run long goal'
        });
        expect(mandate.goal).toHaveLength(2000);

        // Path 4: updateMandate with a different 2000-char goal
        const updatedMandate = await collab.updateMandate(
          scopeA,
          'man_long',
          { expectedRevision: 1, goal: otherLongGoal },
          'bob'
        );
        expect(updatedMandate.goal).toHaveLength(2000);
        expect(updatedMandate.goal[0]).toBe('M');

        // Every followup/mandate activity row was inserted (transaction not rolled back)
        // and each stored summary is capped at 1000 characters.
        const activities = await collab.listActivities(scopeA, 100);
        const goalActivities = activities.filter(a =>
          (a.entityKind === 'followup' || a.entityKind === 'mandate') &&
          (a.summary.startsWith('Created followup') || a.summary.startsWith('Updated followup') ||
           a.summary.startsWith('Created mandate') || a.summary.startsWith('Updated mandate'))
        );
        expect(goalActivities.length).toBe(4);
        for (const activity of goalActivities) {
          expect(activity.summary.length).toBeLessThanOrEqual(1000);
        }
      } finally {
        repos.close();
      }
    });
  });

  describe('Decisions & Feedback', () => {
    it('records decision without overwriting duplicate IDs and saves feedback separately', async () => {
      const repos = createRepositories(':memory:');
      try {
        const collab = repos.collaboration;

        const decision1 = await collab.recordDecision({
          id: 'dec_100',
          scope: scopeA,
          contextRevision: 1,
          policyVersion: 'v1',
          action: 'reply',
          reason: 'Authorized query',
          evidenceIds: ['obs_1'],
          status: 'sent',
          response: 'Here is the report',
          inputSnapshot: { prompt: 'status' },
          createdAt: isoTime1
        });
        expect(decision1.id).toBe('dec_100');

        // Recording same ID again does NOT overwrite
        const duplicate = await collab.recordDecision({
          id: 'dec_100',
          scope: scopeA,
          contextRevision: 2,
          policyVersion: 'v2',
          action: 'silent',
          reason: 'Different reason',
          evidenceIds: [],
          status: 'suppressed',
          inputSnapshot: {},
          createdAt: isoTime2
        });
        expect(duplicate.action).toBe('reply');
        expect(duplicate.policyVersion).toBe('v1');

        // Update decision
        const updatedDecision = await collab.updateDecision(scopeA, 'dec_100', {
          status: 'failed',
          response: 'Delivery timeout'
        });
        expect(updatedDecision.status).toBe('failed');
        expect(updatedDecision.response).toBe('Delivery timeout');

        // Add feedback for decision
        const feedback = await collab.addFeedback({
          id: 'fb_1',
          scope: scopeA,
          decisionId: 'dec_100',
          actorId: 'evaluator_1',
          correction: 'Should not have replied with confidential details',
          expectedAction: 'silent',
          createdAt: isoTime3
        });
        expect(feedback.correction).toContain('Should not have replied');

        const feedbacks = await collab.listFeedback(scopeA, 'dec_100');
        expect(feedbacks.length).toBe(1);
        expect(feedbacks[0].actorId).toBe('evaluator_1');

        // Cross-scope feedback fails 404
        await expect(
          collab.addFeedback({
            id: 'fb_2',
            scope: scopeB,
            decisionId: 'dec_100',
            actorId: 'evaluator_1',
            correction: 'Illegal feedback',
            createdAt: isoTime3
          })
        ).rejects.toThrow(RuntimeError);
      } finally {
        repos.close();
      }
    });
  });

  describe('Actions: Idempotency, Parameter Conflict & Fail-Closed State Transitions', () => {
    it('finds an old pending acknowledgement beyond 501 newer actions from another app without capping pending results', async () => {
      const repos = createRepositories(':memory:');
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const collab = repos.collaboration;
        vi.setSystemTime(isoTime1);
        const { action } = await collab.beginAction({ id: 'old_ack', scope: scopeA, kind: 'participation.ack', requesterId: 'owner', inputDigest: 'old_ack' });
        const pending = await collab.updateAction(scopeA, action.id, { expectedRevision: 1, status: 'sending', receipt: 'old_reaction' });
        vi.setSystemTime(isoTime2);
        for (let index = 0; index < 501; index++) {
          const id = `new_ack_${index}`;
          await collab.beginAction({ id, scope: scopeB, kind: 'participation.ack', requesterId: 'owner', inputDigest: id });
        }
        const recent = await collab.listActions(undefined, 1000);
        expect(recent).toHaveLength(500);
        expect(recent.some(item => item.id === action.id)).toBe(false);
        expect(await collab.listPendingActions(scopeA.appId, 'participation.ack')).toEqual([pending]);
        expect(await collab.listPendingActions(scopeB.appId, 'participation.ack')).toHaveLength(501);
      } finally {
        vi.useRealTimers();
        repos.close();
      }
    });

    it('isolates pending actions by app, kind and status across chats with stable creation and ID ordering', async () => {
      const repos = createRepositories(':memory:');
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const collab = repos.collaboration;
        const begin = (id: string, scope = scopeA, kind = 'participation.ack') => collab.beginAction({ id, scope, kind, requesterId: 'owner', inputDigest: id });
        vi.setSystemTime(isoTime2);
        await begin('ack_z_sending');
        await collab.updateAction(scopeA, 'ack_z_sending', { expectedRevision: 1, status: 'sending' });
        const otherChat = { ...scopeA, chatId: 'oc_other_chat' };
        await begin('ack_a_unknown', otherChat);
        await collab.updateAction(otherChat, 'ack_a_unknown', { expectedRevision: 1, status: 'sending' });
        await collab.updateAction(otherChat, 'ack_a_unknown', { expectedRevision: 2, status: 'unknown', receipt: 'uncertain_reaction' });
        await begin('ack_b_intent');
        for (const status of ['succeeded', 'failed', 'suppressed'] as const) {
          const id = `terminal_${status}`;
          await begin(id);
          await collab.updateAction(scopeA, id, { expectedRevision: 1, status: 'sending' });
          await collab.updateAction(scopeA, id, { expectedRevision: 2, status });
        }
        await begin('other_kind', scopeA, 'participation.reply');
        await begin('other_app', scopeB);
        vi.setSystemTime(isoTime1);
        await begin('ack_zz_old');
        const pending = await collab.listPendingActions(scopeA.appId, 'participation.ack');
        expect(pending.map(action => action.id)).toEqual(['ack_zz_old', 'ack_a_unknown', 'ack_b_intent', 'ack_z_sending']);
        expect(pending.map(action => action.status)).toEqual(['intent', 'unknown', 'intent', 'sending']);
        expect((await collab.listPendingActions(scopeA.appId, 'participation.reply')).map(action => action.id)).toEqual(['other_kind']);
        expect((await collab.listPendingActions(scopeB.appId, 'participation.ack')).map(action => action.id)).toEqual(['other_app']);
        expect(await collab.listPendingActions('missing_app', 'participation.ack')).toEqual([]);
      } finally {
        vi.useRealTimers();
        repos.close();
      }
    });

    it('returns existing action on identical parameters, conflicts 409 on parameter change', async () => {
      const repos = createRepositories(':memory:');
      try {
        const collab = repos.collaboration;

        const actionInput = {
          id: 'act_100',
          scope: scopeA,
          kind: 'send_lark_card',
          requesterId: 'user_boss',
          inputDigest: 'digest_aaa',
          payload: { title: 'Alert', count: 42 }
        };

        const first = await collab.beginAction(actionInput);
        expect(first.created).toBe(true);
        expect(first.action.status).toBe('intent');
        expect(first.action.revision).toBe(1);

        // Same ID and identical parameters: returns existing action with created=false
        const second = await collab.beginAction(actionInput);
        expect(second.created).toBe(false);
        expect(second.action.id).toBe('act_100');

        // Same ID but different payload: conflict 409
        await expect(
          collab.beginAction({
            ...actionInput,
            payload: { title: 'Different Alert', count: 99 }
          })
        ).rejects.toThrow(RuntimeError);

        // Same ID but different requesterId: conflict 409
        await expect(
          collab.beginAction({
            ...actionInput,
            requesterId: 'different_user'
          })
        ).rejects.toThrow(RuntimeError);

        // Same ID but different scope: conflict 409
        await expect(
          collab.beginAction({
            ...actionInput,
            scope: scopeB
          })
        ).rejects.toThrow(RuntimeError);
      } finally {
        repos.close();
      }
    });

    it('enforces fail-closed state machine: unknown cannot transition to sending, terminal states cannot transition', async () => {
      const repos = createRepositories(':memory:');
      try {
        const collab = repos.collaboration;

        const { action } = await collab.beginAction({
          id: 'act_flow',
          scope: scopeA,
          kind: 'call_remote_api',
          requesterId: 'user_1',
          inputDigest: 'digest_flow'
        });

        // intent -> sending: allowed
        const sending = await collab.updateAction(scopeA, action.id, {
          expectedRevision: 1,
          status: 'sending'
        });
        expect(sending.status).toBe('sending');
        expect(sending.revision).toBe(2);

        // sending -> unknown: allowed
        const unknownAction = await collab.updateAction(scopeA, action.id, {
          expectedRevision: 2,
          status: 'unknown',
          error: 'Network timeout during transmission'
        });
        expect(unknownAction.status).toBe('unknown');
        expect(unknownAction.revision).toBe(3);

        // UNKNOWN MUST NOT AUTOMATICALLY TRANSITION TO SENDING! Requirement: "unknown不得自动进入sending"
        await expect(
          collab.updateAction(scopeA, action.id, {
            expectedRevision: 3,
            status: 'sending'
          })
        ).rejects.toThrow(RuntimeError);

        // unknown -> succeeded / failed / suppressed: allowed
        const succeeded = await collab.updateAction(scopeA, action.id, {
          expectedRevision: 3,
          status: 'succeeded',
          receipt: 'receipt_after_manual_reconcile'
        });
        expect(succeeded.status).toBe('succeeded');
        expect(succeeded.revision).toBe(4);

        // Terminal state 'succeeded' cannot transition to anything else
        await expect(
          collab.updateAction(scopeA, action.id, {
            expectedRevision: 4,
            status: 'failed'
          })
        ).rejects.toThrow(RuntimeError);
      } finally {
        repos.close();
      }
    });

    it('prevents overwriting a confirmed receipt/error when re-entering a terminal action with the same status', async () => {
      const repos = createRepositories(':memory:');
      try {
        const collab = repos.collaboration;

        const { action } = await collab.beginAction({
          id: 'act_receipt',
          scope: scopeA,
          kind: 'send_message',
          requesterId: 'user_1',
          inputDigest: 'digest_receipt'
        });

        await collab.updateAction(scopeA, action.id, {
          expectedRevision: 1,
          status: 'sending'
        });
        const succeeded = await collab.updateAction(scopeA, action.id, {
          expectedRevision: 2,
          status: 'succeeded',
          receipt: 'original-confirmed-receipt'
        });
        expect(succeeded.status).toBe('succeeded');
        expect(succeeded.receipt).toBe('original-confirmed-receipt');
        expect(succeeded.revision).toBe(3);

        // Same terminal status re-entry with a tampered receipt MUST be rejected (409)
        await expect(
          collab.updateAction(scopeA, action.id, {
            expectedRevision: 3,
            status: 'succeeded',
            receipt: 'tampered-receipt'
          })
        ).rejects.toThrow(RuntimeError);

        // Same terminal status re-entry with added error MUST be rejected (409)
        await expect(
          collab.updateAction(scopeA, action.id, {
            expectedRevision: 3,
            status: 'succeeded',
            error: 'unexpected error injection'
          })
        ).rejects.toThrow(RuntimeError);

        // Identical terminal status re-entry (idempotent, exact same receipt) returns the old object unchanged
        const idempotent = await collab.updateAction(scopeA, action.id, {
          expectedRevision: 3,
          status: 'succeeded',
          receipt: 'original-confirmed-receipt'
        });
        expect(idempotent.revision).toBe(3);
        expect(idempotent.receipt).toBe('original-confirmed-receipt');
        expect(idempotent.error).toBeUndefined();

        // Stored receipt remains the confirmed original
        const reloaded = await collab.getAction(scopeA, action.id);
        expect(reloaded?.receipt).toBe('original-confirmed-receipt');
      } finally {
        repos.close();
      }
    });
  });

  describe('File-backed SQLite Re-open Persistence and Existing Migrations', () => {
    it('persists all collaboration state across database reopen and does not break existing migrations', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'collab-storage-test-'));
      const dbPath = join(testDir, 'test.db');

      try {
        // Step 1: Initialize database, write collaboration data and task data
        let repos = createRepositories(dbPath);
        const collab = repos.collaboration;

        await collab.updateSettings(
          scopeA,
          { expectedRevision: 0, participation: 'selective', instructions: 'Persisted instructions' },
          'init_actor'
        );

        const obs = await collab.observe({
          scope: scopeA,
          source: 'lark',
          eventId: 'evt_p1',
          occurredAt: isoTime1,
          receivedAt: isoTime1,
          senderKind: 'human',
          text: 'persisted observation',
          origin: 'live'
        });

        const fol = await collab.createFollowup({
          scope: scopeA,
          goal: 'Persisted followup',
          createdBy: 'init_actor'
        });

        const man = await collab.createMandate({
          scope: scopeA,
          goal: 'Persisted mandate',
          requesterId: 'init_actor',
          followupId: fol.id,
          scheduleDefinitionId: 'sched_p1',
          mode: 'notify',
          prompt: 'Run persisted'
        });

        const act = await collab.beginAction({
          id: 'act_persisted',
          scope: scopeA,
          kind: 'persisted_kind',
          requesterId: 'init_actor',
          inputDigest: 'p_digest'
        });

        // Close repository
        repos.close();

        // Step 2: Reopen repository from disk and verify all state is intact
        repos = createRepositories(dbPath);
        const reloadedCollab = repos.collaboration;

        const settings = await reloadedCollab.getSettings(scopeA);
        expect(settings.revision).toBe(1);
        expect(settings.participation).toBe('selective');
        expect(settings.instructions).toBe('Persisted instructions');

        const observations = await reloadedCollab.listObservations(scopeA);
        expect(observations.length).toBe(1);
        expect(observations[0].id).toBe(obs.observation.id);
        expect(observations[0].text).toBe('persisted observation');

        const followups = await reloadedCollab.listFollowups(scopeA);
        expect(followups.length).toBe(1);
        expect(followups[0].id).toBe(fol.id);

        const mandates = await reloadedCollab.listMandates(scopeA);
        expect(mandates.length).toBe(1);
        expect(mandates[0].id).toBe(man.id);

        const action = await reloadedCollab.getAction(scopeA, 'act_persisted');
        expect(action).toBeDefined();
        expect(action?.status).toBe('intent');

        const snap = await reloadedCollab.snapshot(scopeA);
        expect(snap.contextRevision).toBe(4); // 1 (settings) + 1 (obs) + 1 (followup) + 1 (mandate)
        expect(snap.followups.length).toBe(1);
        expect(snap.mandates.length).toBe(1);

        repos.close();
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });
});
