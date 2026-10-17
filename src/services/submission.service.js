const SUBMITTABLE_ATTEMPT_STATUSES = new Set(['in_progress', 'changes_requested']);

export function canSubmitAttempt(status) {
  return SUBMITTABLE_ATTEMPT_STATUSES.has(status);
}
