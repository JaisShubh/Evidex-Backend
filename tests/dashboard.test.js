import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardSummary } from '../src/services/dashboard.service.js';

test('dashboard summary exposes actual counts and chooses a real pending action', () => {
  const result = buildDashboardSummary({
    evidenceCount: 4,
    completedTaskCount: 2,
    pendingReviewCount: 1,
    changesRequestedCount: 0,
    activeAttempt: { id: 'attempt-1', taskTitle: 'Research exercise' },
    latestMatch: { score: 75 },
    ideas: [{ title: 'Saved idea' }],
  });

  assert.deepEqual(result.counts, { evidenceItems: 4, tasksCompleted: 2, pendingReviews: 1, changesRequested: 0 });
  assert.equal(result.recommendedNextStep.action, 'continue_task');
  assert.equal(result.recommendedNextStep.attemptId, 'attempt-1');
  assert.equal(result.opportunityMatchPreview.score, 75);
  assert.equal(result.ideas.length, 1);
});

test('dashboard prioritizes requested changes and otherwise derives setup and experiment actions', () => {
  const common = { evidenceCount: 0, completedTaskCount: 0, pendingReviewCount: 0 };
  assert.equal(buildDashboardSummary({ ...common, changesRequestedCount: 1, activeAttempt: { id: 'a' } }).recommendedNextStep.action, 'review_changes');
  assert.equal(buildDashboardSummary({ ...common, changesRequestedCount: 0 }).recommendedNextStep.action, 'add_evidence');
  assert.equal(buildDashboardSummary({ ...common, evidenceCount: 1, changesRequestedCount: 0, plannedExperiment: { id: 'experiment-1' } }).recommendedNextStep.experimentId, 'experiment-1');
});

test('dashboard activity is newest first and bounded to eight entries', () => {
  const recentActivity = Array.from({ length: 10 }, (_, index) => ({ id: index, date: new Date(`2026-01-${String(index + 1).padStart(2, '0')}`) }));
  const result = buildDashboardSummary({ recentActivity });
  assert.equal(result.recentActivity.length, 8);
  assert.equal(result.recentActivity[0].id, 9);
  assert.equal(result.recentActivity.at(-1).id, 2);
});
