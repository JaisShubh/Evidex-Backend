import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { Appeal, Task } from '../src/models/Work.js';
import { User } from '../src/models/User.js';
import { Application, Opportunity } from '../src/models/Venture.js';

const enabled = process.env.EVIDEX_INTEGRATION_TESTS === 'true';
const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
};

test('MongoDB-backed API journeys and access controls', { skip: !enabled && 'Set EVIDEX_INTEGRATION_TESTS=true to run against an isolated temporary database.' }, async () => {
  assert.ok(process.env.MONGODB_URI, 'MONGODB_URI must be configured (normally in Backend/.env).');
  assert.ok(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32, 'JWT_SECRET must contain at least 32 characters.');

  const dbName = `evidex_it_${crypto.randomBytes(12).toString('hex')}`;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  let server;

  try {
    await mongoose.connect(process.env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 10_000 });
    await Application.init();
    await Appeal.init();
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const call = async (method, path, { token, body } = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json();
      return { status: response.status, payload };
    };

    const register = async (label) => {
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const email = `${slug}-${crypto.randomUUID()}@example.com`;
      const result = await call('POST', '/api/auth/register', {
        body: { name: label, email, password: 'Integration-Test-Password-42' },
      });
      assert.equal(result.status, 201, JSON.stringify(result.payload));
      return { token: result.payload.data.token, user: result.payload.data.user, email };
    };

    const student = await register('Integration Student');
    const reviewerUser = await register('Integration Reviewer');
    const appealReviewerUser = await register('Appeal Reviewer');
    const adminUser = await register('Integration Admin');
    const roleTarget = await register('Role Target');
    await User.updateOne({ _id: reviewerUser.user.id }, { $set: { role: 'reviewer' } });
    await User.updateOne({ _id: appealReviewerUser.user.id }, { $set: { role: 'reviewer' } });
    await User.updateOne({ _id: adminUser.user.id }, { $set: { role: 'admin' } });
    const reviewerToken = jwt.sign({ id: reviewerUser.user.id, role: 'reviewer' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const appealReviewerToken = jwt.sign({ id: appealReviewerUser.user.id, role: 'reviewer' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const adminToken = jwt.sign({ id: adminUser.user.id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '5m' });

    assert.equal((await call('GET', '/api/profile/me')).status, 401);
    assert.equal((await call('GET', '/api/profile/me', { token: 'invalid.token.value' })).payload.error.code, 'INVALID_TOKEN');
    assert.equal((await call('GET', '/api/profile/me', { token: student.token })).status, 200);
    assert.equal((await call('POST', '/api/auth/register', { body: { name: '', email: 'bad', password: 'short' } })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', {
      body: { name: 'Public Admin Attempt', email: 'public-admin-attempt@example.com', password: 'Integration-Test-Password-42', role: 'admin' },
    })).status, 400);
    assert.equal((await call('GET', '/api/reviews/queue', { token: student.token })).status, 403);
    assert.equal((await call('PATCH', `/api/admin/users/${roleTarget.user.id}/access`, { token: student.token, body: { role: 'reviewer' } })).status, 403);
    const accessChange = await call('PATCH', `/api/admin/users/${roleTarget.user.id}/access`, { token: adminToken, body: { role: 'reviewer' } });
    assert.equal(accessChange.status, 200, JSON.stringify(accessChange.payload));
    assert.equal(accessChange.payload.data.role, 'reviewer');
    assert.equal((await call('GET', '/api/reviews/queue', { token: roleTarget.token })).payload.error.code, 'INVALID_TOKEN');
    const roleTargetLogin = await call('POST', '/api/auth/login', { body: { email: roleTarget.email, password: 'Integration-Test-Password-42' } });
    assert.equal(roleTargetLogin.status, 200, JSON.stringify(roleTargetLogin.payload));
    assert.equal((await call('GET', '/api/reviews/queue', { token: roleTargetLogin.payload.data.token })).status, 200);
    const accessHistory = await call('GET', `/api/admin/users/${roleTarget.user.id}/access-history`, { token: adminToken });
    assert.equal(accessHistory.status, 200);
    assert.equal(accessHistory.payload.data[0].source, 'admin_api');
    assert.equal((await call('PATCH', `/api/admin/users/${adminUser.user.id}/access`, { token: adminToken, body: { role: 'student' } })).status, 403);
    const suspension = await call('PATCH', `/api/admin/users/${roleTarget.user.id}/access`, { token: adminToken, body: { status: 'suspended' } });
    assert.equal(suspension.status, 200);
    assert.equal((await call('GET', '/api/reviews/queue', { token: roleTargetLogin.payload.data.token })).payload.error.code, 'INVALID_TOKEN');
    assert.equal((await call('POST', '/api/auth/login', { body: { email: roleTarget.email, password: 'Integration-Test-Password-42' } })).payload.error.code, 'INVALID_CREDENTIALS');

    const project = await call('POST', '/api/projects', {
      token: student.token,
      body: { title: 'Integration project', description: 'A temporary test project.', skills: ['Research'] },
    });
    assert.equal(project.status, 201, JSON.stringify(project.payload));
    const evidence = await call('POST', '/api/evidence', {
      token: student.token,
      body: { title: 'Integration evidence', type: 'project', skills: ['Research'] },
    });
    assert.equal(evidence.status, 201, JSON.stringify(evidence.payload));
    assert.equal((await call('GET', '/api/projects/me', { token: reviewerUser.token })).payload.data.length, 0);

    const task = await Task.create({
      title: 'Integration task', goal: 'Complete the test workflow.', description: 'Temporary integration task.',
      requiredSkills: ['Research'], deliverables: [{ name: 'Summary', required: true }],
      rubric: [{ criterion: 'Clarity', points: 10, description: 'Clear summary.' }], version: 1, status: 'published',
    });
    const attempt = await call('POST', `/api/tasks/${task.id}/attempts`, { token: student.token });
    assert.equal(attempt.status, 201, JSON.stringify(attempt.payload));
    const attemptId = attempt.payload.data._id;
    assert.equal((await call('GET', `/api/attempts/${attemptId}/submissions`, { token: reviewerUser.token })).status, 404);
    assert.equal((await call('POST', `/api/attempts/${attemptId}/submissions`, {
      token: student.token, body: { deliverables: [{ name: 'Other', value: 'This does not satisfy the required Summary deliverable.' }] },
    })).status, 400);

    const submission = await call('POST', `/api/attempts/${attemptId}/submissions`, {
      token: student.token, body: { deliverables: [{ name: 'Summary', value: 'A temporary test summary.' }] },
    });
    assert.equal(submission.status, 201, JSON.stringify(submission.payload));
    const submissionId = submission.payload.data._id;
    assert.equal(submission.payload.data.version, 1);
    assert.equal((await call('POST', `/api/attempts/${attemptId}/submissions`, {
      token: student.token, body: { deliverables: [{ name: 'Summary', value: 'Duplicate submission.' }] },
    })).status, 409);

    const verification = await call('POST', `/api/submissions/${submissionId}/verify`, { token: student.token });
    assert.equal(verification.status, 200, JSON.stringify(verification.payload));
    assert.equal(verification.payload.data.submission.status, 'checks_passed');
    assert.deepEqual(verification.payload.data.checks.map(({ name, status }) => ({ name, status })), [{ name: 'Completeness: Summary', status: 'passed' }]);
    assert.match(verification.payload.data.warnings[0], /correctness.*not checked/);
    assert.equal((await call('GET', `/api/submissions/${submissionId}/verification`, { token: reviewerUser.token })).status, 200);
    assert.equal((await call('GET', `/api/submissions/${submissionId}/verification`, { token: reviewerToken })).status, 200);

    const review = await call('POST', `/api/submissions/${submissionId}/reviews`, {
      token: reviewerToken,
      body: { rubricScores: [{ criterion: 'Clarity', score: 9, maxScore: 10 }], feedback: 'Integration test review.', decision: 'verified' },
    });
    assert.equal(review.status, 201, JSON.stringify(review.payload));
    assert.equal((await call('GET', `/api/submissions/${submissionId}/reviews`, { token: student.token })).payload.data.length, 1);

    const appealAttempt = await call('POST', `/api/tasks/${task.id}/attempts`, { token: student.token });
    assert.equal(appealAttempt.status, 201, JSON.stringify(appealAttempt.payload));
    const appealAttemptId = appealAttempt.payload.data._id;
    const appealSubmission = await call('POST', `/api/attempts/${appealAttemptId}/submissions`, {
      token: student.token, body: { deliverables: [{ name: 'Summary', value: 'A second temporary test summary.' }] },
    });
    assert.equal(appealSubmission.status, 201, JSON.stringify(appealSubmission.payload));
    const appealSubmissionId = appealSubmission.payload.data._id;
    const rejection = await call('POST', `/api/submissions/${appealSubmissionId}/reviews`, {
      token: reviewerToken,
      body: { rubricScores: [{ criterion: 'Clarity', score: 2, maxScore: 10 }], feedback: 'Integration rejection for appeal workflow.', decision: 'rejected' },
    });
    assert.equal(rejection.status, 201, JSON.stringify(rejection.payload));
    const appeal = await call('POST', `/api/submissions/${appealSubmissionId}/appeals`, {
      token: student.token, body: { reason: 'Please reconsider this test rejection.' },
    });
    assert.equal(appeal.status, 201, JSON.stringify(appeal.payload));
    assert.equal((await call('GET', '/api/appeals/queue', { token: student.token })).status, 403);
    assert.equal((await call('GET', '/api/appeals/me', { token: student.token })).payload.data.length, 1);
    assert.equal((await call('POST', `/api/appeals/${appeal.payload.data._id}/resolve`, {
      token: reviewerToken, body: { decision: 'overturned', resolution: 'Original reviewer cannot decide this appeal.' },
    })).status, 403);
    const appealResolution = await call('POST', `/api/appeals/${appeal.payload.data._id}/resolve`, {
      token: appealReviewerToken, body: { decision: 'overturned', resolution: 'Reopen for a corrected submission.' },
    });
    assert.equal(appealResolution.status, 200, JSON.stringify(appealResolution.payload));
    assert.equal(appealResolution.payload.data.submission.status, 'changes_requested');
    const resubmission = await call('POST', `/api/attempts/${appealAttemptId}/submissions`, {
      token: student.token, body: { deliverables: [{ name: 'Summary', value: 'A resubmission after the appeal was overturned.' }] },
    });
    assert.equal(resubmission.status, 201, JSON.stringify(resubmission.payload));
    assert.equal(resubmission.payload.data.version, 2);

    const idea = await call('POST', '/api/ideas', {
      token: student.token,
      body: { title: 'Integration idea', description: 'A temporary idea used only for API testing.' },
    });
    assert.equal(idea.status, 201, JSON.stringify(idea.payload));
    process.env.GEMINI_API_KEY = '';
    const analysis = await call('POST', '/api/venture/deconstruct', {
      token: student.token, body: { ideaId: idea.payload.data._id },
    });
    assert.equal(analysis.status, 201, JSON.stringify(analysis.payload));
    assert.match(analysis.payload.data.notice, /Sample response/);
    const experimentId = analysis.payload.data.experiments[0]._id;
    const result = await call('POST', `/api/experiments/${experimentId}/results`, {
      token: student.token,
      body: { observations: 'Temporary integration observation.', outcome: 'inconclusive', evidenceIds: [evidence.payload.data._id] },
    });
    assert.equal(result.status, 201, JSON.stringify(result.payload));
    assert.equal((await call('GET', `/api/ideas/${idea.payload.data._id}/results`, { token: student.token })).payload.data.length, 1);

    const opportunity = await Opportunity.create({
      title: 'Integration opportunity', provider: 'Temporary test provider', description: 'Temporary test record.',
      requiredSkills: ['Research'], eligibility: [], status: 'published',
    });
    const match = await call('POST', '/api/match/calculate', { token: student.token, body: { opportunityId: opportunity.id } });
    assert.equal(match.status, 201, JSON.stringify(match.payload));
    assert.ok(Number.isFinite(match.payload.data.score));
    assert.equal((await call('GET', '/api/matches/me', { token: student.token })).payload.data.length, 1);

    const application = await call('POST', `/api/opportunities/${opportunity.id}/applications`, { token: student.token, body: { message: 'Integration application.' } });
    assert.equal(application.status, 201, JSON.stringify(application.payload));
    assert.equal((await call('POST', `/api/opportunities/${opportunity.id}/applications`, { token: student.token, body: {} })).status, 409);
    assert.equal((await call('GET', '/api/applications/me', { token: student.token })).payload.data.length, 1);

    const dashboard = await call('GET', '/api/dashboard', { token: student.token });
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.payload));
    assert.equal(dashboard.payload.data.counts.evidenceItems, 4);
    assert.equal(dashboard.payload.data.counts.tasksCompleted, 1);
  } catch (error) {
    console.error('Integration journey failed:', error);
    throw error;
  } finally {
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiKey;
    if (server?.listening) {
      server.closeAllConnections();
      server.close();
    }
    if (mongoose.connection.readyState !== 0) {
      try {
        if (mongoose.connection.readyState === 1) {
          await withTimeout(mongoose.connection.dropDatabase(), 10_000, 'Timed out dropping isolated integration database.');
        }
      } finally {
        await mongoose.disconnect();
      }
    }
  }
});
