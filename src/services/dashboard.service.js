const dateValue = (value) => new Date(value || 0).getTime();

export function buildDashboardSummary({
  evidenceCount,
  completedTaskCount,
  pendingReviewCount,
  changesRequestedCount,
  activeAttempt,
  plannedExperiment,
  latestMatch,
  ideas = [],
  recentActivity = [],
}) {
  let recommendedNextStep;
  if (changesRequestedCount > 0) {
    recommendedNextStep = { action: 'review_changes', label: 'Review requested changes' };
  } else if (activeAttempt) {
    recommendedNextStep = {
      action: 'continue_task',
      label: `Continue ${activeAttempt.taskTitle || 'your active task'}`,
      attemptId: activeAttempt.id,
    };
  } else if (plannedExperiment) {
    recommendedNextStep = {
      action: 'record_experiment',
      label: 'Record what happened in your planned experiment',
      experimentId: plannedExperiment.id,
    };
  } else if (evidenceCount === 0) {
    recommendedNextStep = { action: 'add_evidence', label: 'Add evidence to support a profile skill' };
  } else {
    recommendedNextStep = { action: 'browse_opportunities', label: 'Explore opportunities that match your skills' };
  }

  return {
    counts: {
      evidenceItems: evidenceCount,
      tasksCompleted: completedTaskCount,
      pendingReviews: pendingReviewCount,
      changesRequested: changesRequestedCount,
    },
    recommendedNextStep,
    recentActivity: [...recentActivity]
      .sort((a, b) => dateValue(b.date) - dateValue(a.date))
      .slice(0, 8),
    opportunityMatchPreview: latestMatch || null,
    ideas: ideas.slice(0, 3),
  };
}
