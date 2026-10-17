import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { Task, Attempt, Submission, Evidence, VerificationRun } from '../src/models/Work.js';
import { Idea, ExperimentResult, Application } from '../src/models/Venture.js';
import { canSubmitAttempt } from '../src/services/submission.service.js';

const id = () => new mongoose.Types.ObjectId();

test('user and profile schemas require safe account fields and default private visibility', async () => {
  const user = new User({ name: 'Demo', email: 'demo@example.test', passwordHash: 'hash', role: 'student' });
  await user.validate();
  assert.equal(user.profile.visibility, 'private');
  assert.equal(user.status, 'active');
  assert.equal(user.tokenVersion, 0);
  await assert.rejects(new User({ name: 'Demo', email: 'demo@example.test', passwordHash: 'hash', role: 'hacker' }).validate());
});

test('task attempts preserve the task version and submission versions are required', async () => {
  const task = new Task({ title: 'Trial', goal: 'Practice', description: 'Task', rubric: [], deliverables: [], version: 3 });
  await task.validate();
  const attempt = new Attempt({ userId: id(), taskId: id(), taskVersion: task.version });
  await attempt.validate();
  assert.equal(attempt.taskVersion, 3);
  await assert.rejects(new Submission({ attemptId: id(), userId: id() }).validate());
});

test('evidence, idea, and experiment result status fields reject unknown values', async () => {
  await assert.rejects(new Evidence({ userId: id(), title: 'Proof', status: 'probably-real' }).validate());
  await assert.rejects(new Idea({ userId: id(), title: 'Idea', description: 'Text', status: 'proven' }).validate());
  await assert.rejects(new ExperimentResult({ experimentId: id(), userId: id(), observations: 'Observed', outcome: 'proven' }).validate());
  const sample = new Evidence({ userId: id(), title: 'Sample only', provenance: 'sample', status: 'needs_review' });
  await sample.validate();
});

test('verification runs persist the check result and its limitations', async () => {
  const run = new VerificationRun({
    submissionId: id(),
    checks: [{ name: 'Completeness', status: 'passed', meaning: 'Required fields were submitted.' }],
    results: { overallStatus: 'checks_passed' },
    warnings: ['Checks do not establish authorship.'],
  });
  await run.validate();
  assert.equal(run.warnings.length, 1);
});

test('applications prevent duplicate user-opportunity pairs with a unique compound index', () => {
  const index = Application.schema.indexes().find(([keys, options]) => keys.userId === 1 && keys.opportunityId === 1 && options.unique);
  assert.ok(index);
});

test('submissions are allowed once per attempt and again only after changes are requested', () => {
  assert.equal(canSubmitAttempt('in_progress'), true);
  assert.equal(canSubmitAttempt('changes_requested'), true);
  assert.equal(canSubmitAttempt('submitted'), false);
  assert.equal(canSubmitAttempt('checks_passed'), false);
  assert.equal(canSubmitAttempt('verified'), false);
  assert.equal(canSubmitAttempt('rejected'), false);
});

