import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { Appeal, Evidence } from '../src/models/Work.js';
import { User } from '../src/models/User.js';
import { Application } from '../src/models/Venture.js';
import { ProfileShare } from '../src/models/Sharing.js';

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
    await ProfileShare.init();
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const httpFetch = globalThis.fetch;

    const call = async (method, path, { token, body, headers: extraHeaders = {} } = {}) => {
      const response = await httpFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...extraHeaders,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json();
      return { status: response.status, payload };
    };

    const register = async (label, role = 'student') => {
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const email = `${slug}-${crypto.randomUUID()}@example.com`;
      const result = await call('POST', '/api/auth/register', {
        body: { name: label, email, password: 'Integration-Test-Password-42', ...(role === 'student' ? {} : { role }) },
      });
      assert.equal(result.status, 201, JSON.stringify(result.payload));
      return { token: result.payload.data.token, user: result.payload.data.user, email };
    };

    const student = await register('Integration Student');
    const founder = await register('Integration Founder', 'founder');
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
    assert.equal((await call('GET', '/api/talent-board/candidates', { token: student.token })).status, 403);
    await call('PATCH', '/api/profile/me', { token: student.token, body: { visibility: 'public', location: 'Delhi', preferredRole: 'Research Intern', skills: [{ name: 'Research', proficiency: 'intermediate' }] } });
    assert.equal((await call('GET', '/api/talent-board/candidates?skill=Research', { token: reviewerToken })).payload.data.length, 0);
    assert.equal((await call('POST', '/api/talent-board/consent', { token: reviewerToken })).status, 403);
    const consent = await call('POST', '/api/talent-board/consent', { token: student.token });
    assert.equal(consent.status, 200);
    assert.equal(consent.payload.data.enabled, true);
    const board = await call('GET', '/api/talent-board/candidates?skill=Research&location=delhi', { token: reviewerToken });
    assert.equal(board.status, 200);
    assert.equal(board.payload.data.length, 1);
    assert.equal(board.payload.data[0].id, student.user.id);
    assert.equal('email' in board.payload.data[0], false);
    assert.equal((await call('DELETE', '/api/talent-board/consent', { token: student.token })).payload.data.enabled, false);
    assert.equal((await call('GET', '/api/talent-board/candidates?skill=Research', { token: reviewerToken })).payload.data.length, 0);
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
      body: { title: 'Integration project', description: 'A temporary test project.', repositoryUrl: 'https://github.com/evidex-test/example-project', skills: ['Research'] },
    });
    assert.equal(project.status, 201, JSON.stringify(project.payload));
    const projectUpdate = await call('PATCH', `/api/projects/${project.payload.data._id}`, {
      token: student.token, body: { contribution: 'Integration test contribution.' },
    });
    assert.equal(projectUpdate.status, 200);
    assert.equal(projectUpdate.payload.data.contribution, 'Integration test contribution.');
    assert.equal((await call('POST', `/api/projects/${project.payload.data._id}/repository-checks`, { token: reviewerUser.token })).status, 404);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.github.com/repos/evidex-test/example-project');
      assert.equal(options.headers['User-Agent'], 'EVIDEX-backend');
      return new Response(JSON.stringify({ full_name: 'evidex-test/example-project', private: false, description: 'Temporary public repository.', default_branch: 'main', pushed_at: '2026-10-01T00:00:00Z', archived: false, stargazers_count: 3 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const repositoryCheck = await call('POST', `/api/projects/${project.payload.data._id}/repository-checks`, { token: student.token });
      assert.equal(repositoryCheck.status, 201, JSON.stringify(repositoryCheck.payload));
      assert.equal(repositoryCheck.payload.data.check.providerStatus, 'public');
      assert.equal(repositoryCheck.payload.data.check.fullName, 'evidex-test/example-project');
      assert.match(repositoryCheck.payload.data.meaning, /does not verify ownership/);
      assert.equal((await call('GET', `/api/projects/${project.payload.data._id}/repository-checks`, { token: student.token })).payload.data.length, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
    assert.equal((await call('PATCH', `/api/projects/${project.payload.data._id}`, { token: reviewerUser.token, body: { title: 'Unauthorized edit' } })).status, 404);
    const evidence = await call('POST', '/api/evidence', {
      token: student.token,
      body: { title: 'Integration evidence', type: 'project', skills: ['Research'], relatedProjectId: project.payload.data._id },
    });
    assert.equal(evidence.status, 201, JSON.stringify(evidence.payload));
    const evidenceUpdate = await call('PATCH', `/api/evidence/${evidence.payload.data._id}`, {
      token: student.token, body: { title: 'Edited integration evidence' },
    });
    assert.equal(evidenceUpdate.status, 200);
    assert.equal(evidenceUpdate.payload.data.title, 'Edited integration evidence');
    assert.equal(evidenceUpdate.payload.data.provenance, 'user_reported');
    const profileUpdate = await call('PATCH', '/api/profile/me', {
      token: student.token,
      body: { bio: 'A private test bio.', location: 'Private test location', skills: [{ name: 'Research', proficiency: 'intermediate', evidenceIds: [evidence.payload.data._id] }] },
    });
    assert.equal(profileUpdate.status, 200, JSON.stringify(profileUpdate.payload));
    const otherProject = await call('POST', '/api/projects', {
      token: reviewerUser.token, body: { title: 'Other user project' },
    });
    assert.equal(otherProject.status, 201, JSON.stringify(otherProject.payload));
    assert.equal((await call('POST', '/api/profile/shares', {
      token: student.token, body: { projectIds: [otherProject.payload.data._id] },
    })).status, 404);
    const createdShare = await call('POST', '/api/profile/shares', {
      token: student.token,
      body: { profileFields: ['displayName', 'bio', 'skills'], projectIds: [project.payload.data._id], evidenceIds: [evidence.payload.data._id], expiresInDays: 7 },
    });
    assert.equal(createdShare.status, 201, JSON.stringify(createdShare.payload));
    const shareToken = createdShare.payload.data.shareToken;
    const unsharedEvidence = await call('POST', '/api/evidence', {
      token: student.token, body: { title: 'Unshared integration evidence', type: 'other' },
    });
    assert.equal(unsharedEvidence.status, 201, JSON.stringify(unsharedEvidence.payload));
    const publicProfile = await call('GET', '/api/shared/profile', { headers: { 'X-Profile-Share': shareToken } });
    assert.equal(publicProfile.status, 200, JSON.stringify(publicProfile.payload));
    assert.equal(publicProfile.payload.data.profile.bio, 'A private test bio.');
    assert.equal('location' in publicProfile.payload.data.profile, false);
    assert.equal('email' in publicProfile.payload.data.profile, false);
    assert.equal(publicProfile.payload.data.projects.length, 1);
    assert.equal(publicProfile.payload.data.evidence.length, 1);
    const storedShare = await ProfileShare.findById(createdShare.payload.data.id).select('+tokenHash');
    assert.notEqual(storedShare.tokenHash, shareToken);
    const shareList = await call('GET', '/api/profile/shares/me', { token: student.token });
    assert.equal(shareList.status, 200);
    assert.equal('tokenHash' in shareList.payload.data[0], false);
    assert.equal((await call('DELETE', `/api/profile/shares/${createdShare.payload.data.id}`, { token: reviewerUser.token })).status, 404);
    assert.equal((await call('DELETE', `/api/profile/shares/${createdShare.payload.data.id}`, { token: student.token })).status, 200);
    assert.equal((await call('GET', '/api/shared/profile', { headers: { 'X-Profile-Share': shareToken } })).status, 404);
    const expiringShare = await call('POST', '/api/profile/shares', { token: student.token, body: { profileFields: ['bio'], expiresInDays: 1 } });
    assert.equal(expiringShare.status, 201, JSON.stringify(expiringShare.payload));
    await ProfileShare.updateOne({ _id: expiringShare.payload.data.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await call('GET', '/api/shared/profile', { headers: { 'X-Profile-Share': expiringShare.payload.data.shareToken } })).status, 404);
    const reviewerProjects = await call('GET', '/api/projects/me', { token: reviewerUser.token });
    const studentProjects = await call('GET', '/api/projects/me', { token: student.token });
    assert.equal(reviewerProjects.payload.data.length, 1);
    assert.equal(reviewerProjects.payload.data[0]._id, otherProject.payload.data._id);
    assert.equal(studentProjects.payload.data.length, 1);
    assert.equal(studentProjects.payload.data[0]._id, project.payload.data._id);

    const taskCreated = await call('POST', '/api/admin/tasks', {
      token: adminToken,
      body: { title: 'Integration task', goal: 'Complete the test workflow.', description: 'Temporary integration task.', requiredSkills: ['Research'], deliverables: [{ name: 'Summary', required: true }], rubric: [{ criterion: 'Clarity', points: 10, description: 'Clear summary.' }] },
    });
    assert.equal(taskCreated.status, 201, JSON.stringify(taskCreated.payload));
    assert.equal(taskCreated.payload.data.status, 'draft');
    assert.equal((await call('POST', '/api/admin/tasks', { token: student.token, body: {} })).status, 403);
    assert.equal((await call('GET', '/api/tasks', { token: student.token })).payload.data.length, 0);
    const publishedTask = await call('PATCH', `/api/admin/tasks/${taskCreated.payload.data._id}`, { token: adminToken, body: { status: 'published' } });
    assert.equal(publishedTask.status, 200, JSON.stringify(publishedTask.payload));
    assert.equal(publishedTask.payload.data.version, 2);
    const taskId = publishedTask.payload.data._id;
    const attempt = await call('POST', `/api/tasks/${taskId}/attempts`, { token: student.token });
    assert.equal(attempt.status, 201, JSON.stringify(attempt.payload));
    const attemptId = attempt.payload.data._id;
    assert.equal(attempt.payload.data.taskVersion, 2);
    assert.equal(attempt.payload.data.taskSnapshot.rubric[0].criterion, 'Clarity');
    const taskRevision = await call('PATCH', `/api/admin/tasks/${taskId}`, {
      token: adminToken, body: { rubric: [{ criterion: 'Specificity', points: 12, description: 'Specific summary.' }] },
    });
    assert.equal(taskRevision.status, 200);
    assert.equal(taskRevision.payload.data.version, 3);
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
    const taskEvidence = await Evidence.findOne({ relatedSubmissionId: submissionId });
    assert.equal((await call('PATCH', `/api/evidence/${taskEvidence.id}`, { token: student.token, body: { title: 'Edited reviewed evidence' } })).status, 409);
    assert.equal((await call('DELETE', `/api/evidence/${taskEvidence.id}`, { token: student.token })).status, 409);
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

    const appealAttempt = await call('POST', `/api/tasks/${taskId}/attempts`, { token: student.token });
    assert.equal(appealAttempt.status, 201, JSON.stringify(appealAttempt.payload));
    const appealAttemptId = appealAttempt.payload.data._id;
    assert.equal(appealAttempt.payload.data.taskVersion, 3);
    assert.equal(appealAttempt.payload.data.taskSnapshot.rubric[0].criterion, 'Specificity');
    const appealSubmission = await call('POST', `/api/attempts/${appealAttemptId}/submissions`, {
      token: student.token, body: { deliverables: [{ name: 'Summary', value: 'A second temporary test summary.' }] },
    });
    assert.equal(appealSubmission.status, 201, JSON.stringify(appealSubmission.payload));
    const appealSubmissionId = appealSubmission.payload.data._id;
    const rejection = await call('POST', `/api/submissions/${appealSubmissionId}/reviews`, {
      token: reviewerToken,
      body: { rubricScores: [{ criterion: 'Specificity', score: 2, maxScore: 12 }], feedback: 'Integration rejection for appeal workflow.', decision: 'rejected' },
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
    const ideaUpdate = await call('PATCH', `/api/ideas/${idea.payload.data._id}`, { token: student.token, body: { targetCustomer: 'Test participants' } });
    assert.equal(ideaUpdate.status, 200);
    assert.equal((await call('GET', `/api/ideas/${idea.payload.data._id}`, { token: student.token })).payload.data.targetCustomer, 'Test participants');
    assert.equal((await call('POST', `/api/ideas/${idea.payload.data._id}/research`, { token: reviewerUser.token, body: { evidenceIds: [evidence.payload.data._id] } })).status, 404);
    const research = await call('POST', `/api/ideas/${idea.payload.data._id}/research`, {
      token: student.token, body: { evidenceIds: [evidence.payload.data._id], notes: 'User-recorded test research reference.' },
    });
    assert.equal(research.status, 201, JSON.stringify(research.payload));
    assert.equal(research.payload.data.ideaStatus, 'researched');
    assert.equal((await call('GET', `/api/ideas/${idea.payload.data._id}/research`, { token: student.token })).payload.data.length, 1);
    process.env.GEMINI_API_KEY = '';
    const analysis = await call('POST', '/api/venture/deconstruct', {
      token: student.token, body: { ideaId: idea.payload.data._id },
    });
    assert.equal(analysis.status, 201, JSON.stringify(analysis.payload));
    assert.match(analysis.payload.data.notice, /Sample response/);
    assert.equal(analysis.payload.data.analysis.promptVersion, '1');
    const repeatedAnalysis = await call('POST', '/api/venture/deconstruct', { token: student.token, body: { ideaId: idea.payload.data._id } });
    assert.equal(repeatedAnalysis.status, 201);
    assert.equal((await call('GET', `/api/ideas/${idea.payload.data._id}/experiments`, { token: student.token })).payload.data.length, 1);
    assert.equal((await call('GET', `/api/ideas/${idea.payload.data._id}/analyses`, { token: student.token })).payload.data.length, 2);
    const experimentId = analysis.payload.data.experiments[0]._id;
    const result = await call('POST', `/api/experiments/${experimentId}/results`, {
      token: student.token,
      body: { observations: 'Temporary integration observation.', outcome: 'inconclusive', evidenceIds: [evidence.payload.data._id] },
    });
    assert.equal(result.status, 201, JSON.stringify(result.payload));
    assert.equal((await call('GET', `/api/ideas/${idea.payload.data._id}/results`, { token: student.token })).payload.data.length, 1);

    const generatedBrief = await call('POST', '/api/briefs/generate-draft', { token: founder.token, body: { title: 'Generated test brief', context: 'Create a short research task using synthetic information.' } });
    assert.equal(generatedBrief.status, 201, JSON.stringify(generatedBrief.payload));
    assert.equal(generatedBrief.payload.data.brief.status, 'draft');
    assert.equal(generatedBrief.payload.data.brief.draftOrigin, 'sample');
    assert.equal(generatedBrief.payload.data.generation.source, 'sample');
    assert.equal((await call('POST', `/api/briefs/${generatedBrief.payload.data.brief._id}/publish`, { token: founder.token })).payload.error.code, 'APPROVAL_REQUIRED');

    const briefCreated = await call('POST', '/api/briefs', {
      token: founder.token,
      body: { title: 'Integration business brief', problem: 'A scoped test problem.', desiredOutcome: 'A concise research plan.', constraints: 'Use synthetic data only.', effortEstimate: 'Two hours', requiredSkills: ['Research'], deliverables: [{ name: 'Plan', required: true, instructions: 'Describe a safe validation plan.' }], rubric: [{ criterion: 'Clarity', points: 10, description: 'The plan is clear.' }], source: 'ai' },
    });
    assert.equal(briefCreated.status, 201, JSON.stringify(briefCreated.payload));
    const briefId = briefCreated.payload.data._id;
    assert.equal((await call('POST', `/api/briefs/${briefId}/publish`, { token: founder.token })).payload.error.code, 'APPROVAL_REQUIRED');
    assert.equal((await call('GET', `/api/briefs/${briefId}`, { token: student.token })).status, 404);
    assert.equal((await call('POST', `/api/briefs/${briefId}/approve`, { token: founder.token })).status, 403);
    const approvedBrief = await call('POST', `/api/briefs/${briefId}/approve`, { token: adminToken });
    assert.equal(approvedBrief.status, 200);
    const publishedBrief = await call('POST', `/api/briefs/${briefId}/publish`, { token: founder.token });
    assert.equal(publishedBrief.status, 200, JSON.stringify(publishedBrief.payload));
    const briefTaskId = publishedBrief.payload.data.task._id;
    const invitation = await call('POST', `/api/briefs/${briefId}/invitations`, {
      token: founder.token, body: { recipientId: student.user.id, message: 'Please opt in to this private trial.' },
    });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.payload));
    assert.equal(invitation.payload.data.briefVersion, 1);
    assert.equal((await call('POST', `/api/invitations/${invitation.payload.data._id}/respond`, { token: reviewerUser.token, body: { status: 'accepted' } })).status, 404);
    const acceptedInvitation = await call('POST', `/api/invitations/${invitation.payload.data._id}/respond`, { token: student.token, body: { status: 'accepted' } });
    assert.equal(acceptedInvitation.status, 200);
    assert.ok(acceptedInvitation.payload.data.consentAt);
    assert.equal((await call('GET', `/api/briefs/${briefId}`, { token: student.token })).status, 200);
    assert.equal((await call('GET', `/api/tasks/${briefTaskId}`, { token: reviewerUser.token })).status, 404);
    assert.equal((await call('GET', `/api/tasks/${briefTaskId}`, { token: student.token })).status, 200);
    const briefAttempt = await call('POST', `/api/tasks/${briefTaskId}/attempts`, { token: student.token });
    assert.equal(briefAttempt.status, 201, JSON.stringify(briefAttempt.payload));
    const briefSubmission = await call('POST', `/api/attempts/${briefAttempt.payload.data._id}/submissions`, {
      token: student.token, body: { deliverables: [{ name: 'Plan', value: 'A synthetic-data validation plan.' }] },
    });
    assert.equal(briefSubmission.status, 201, JSON.stringify(briefSubmission.payload));
    const briefSubmissions = await call('GET', `/api/briefs/${briefId}/submissions`, { token: founder.token });
    assert.equal(briefSubmissions.status, 200);
    assert.equal(briefSubmissions.payload.data.submissions.length, 1);
    assert.equal(briefSubmissions.payload.data.submissions[0].attemptId.taskVersion, 1);

    const resourceSwap = await call('POST', '/api/resource-swaps', {
      token: student.token,
      body: { recipientId: reviewerUser.user.id, offer: 'Two hours of usability feedback.', request: 'Review a research outline.', terms: 'Schedule together; no payments or guaranteed delivery.' },
    });
    assert.equal(resourceSwap.status, 201, JSON.stringify(resourceSwap.payload));
    const swapId = resourceSwap.payload.data._id;
    assert.equal((await call('GET', `/api/resource-swaps/${swapId}`, { token: adminUser.token })).status, 404);
    assert.equal((await call('POST', `/api/resource-swaps/${swapId}/respond`, { token: student.token, body: { status: 'accepted' } })).status, 404);
    assert.equal((await call('POST', `/api/resource-swaps/${swapId}/respond`, { token: reviewerUser.token, body: { status: 'accepted' } })).status, 200);
    const proposerConfirmation = await call('POST', `/api/resource-swaps/${swapId}/confirm`, { token: student.token });
    assert.equal(proposerConfirmation.status, 200);
    assert.equal(proposerConfirmation.payload.data.status, 'accepted');
    const recipientConfirmation = await call('POST', `/api/resource-swaps/${swapId}/confirm`, { token: reviewerUser.token });
    assert.equal(recipientConfirmation.status, 200);
    assert.equal(recipientConfirmation.payload.data.status, 'completed');
    assert.equal(recipientConfirmation.payload.data.confirmations.length, 2);

    const opportunityCreated = await call('POST', '/api/opportunities', {
      token: founder.token,
      body: { title: 'Integration opportunity', provider: 'Temporary test provider', description: 'Temporary test record.', requiredSkills: ['Research'], eligibility: [] },
    });
    assert.equal(opportunityCreated.status, 201, JSON.stringify(opportunityCreated.payload));
    assert.equal(opportunityCreated.payload.data.status, 'draft');
    const opportunityId = opportunityCreated.payload.data._id;
    assert.equal((await call('GET', '/api/opportunities', { token: student.token })).payload.data.length, 0);
    assert.equal((await call('PATCH', `/api/opportunities/${opportunityId}`, { token: founder.token, body: { status: 'published' } })).status, 403);
    const publishedOpportunity = await call('PATCH', `/api/opportunities/${opportunityId}`, { token: adminToken, body: { status: 'published' } });
    assert.equal(publishedOpportunity.status, 200, JSON.stringify(publishedOpportunity.payload));
    const founderOpportunities = await call('GET', '/api/owner/opportunities', { token: founder.token });
    assert.equal(founderOpportunities.payload.data.length, 1);
    const match = await call('POST', '/api/match/calculate', { token: student.token, body: { opportunityId } });
    assert.equal(match.status, 201, JSON.stringify(match.payload));
    assert.ok(Number.isFinite(match.payload.data.score));
    assert.equal((await call('GET', '/api/matches/me', { token: student.token })).payload.data.length, 1);

    const application = await call('POST', `/api/opportunities/${opportunityId}/applications`, { token: student.token, body: { message: 'Integration application.' } });
    assert.equal(application.status, 201, JSON.stringify(application.payload));
    const applicationId = application.payload.data._id;
    assert.equal((await call('POST', `/api/opportunities/${opportunityId}/applications`, { token: student.token, body: {} })).status, 409);
    assert.equal((await call('GET', `/api/opportunities/${opportunityId}/applications`, { token: student.token })).status, 403);
    const ownerApplications = await call('GET', `/api/opportunities/${opportunityId}/applications`, { token: founder.token });
    assert.equal(ownerApplications.status, 200);
    assert.equal(ownerApplications.payload.data.length, 1);
    assert.equal('email' in ownerApplications.payload.data[0], false);
    assert.equal((await call('PATCH', `/api/applications/${applicationId}/status`, { token: student.token, body: { status: 'accepted' } })).status, 403);
    assert.equal((await call('PATCH', `/api/applications/${applicationId}/status`, { token: founder.token, body: { status: 'reviewing' } })).status, 200);
    const accepted = await call('PATCH', `/api/applications/${applicationId}/status`, { token: founder.token, body: { status: 'accepted' } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.payload.data.statusHistory.length, 2);
    assert.equal((await call('POST', `/api/applications/${applicationId}/withdraw`, { token: student.token })).status, 409);

    const withdrawalOpportunity = await call('POST', '/api/opportunities', {
      token: adminToken,
      body: { title: 'Withdrawal test opportunity', provider: 'Temporary admin provider', description: 'Temporary withdrawal test.', status: 'published' },
    });
    assert.equal(withdrawalOpportunity.status, 201);
    const withdrawalApplication = await call('POST', `/api/opportunities/${withdrawalOpportunity.payload.data._id}/applications`, { token: student.token, body: {} });
    assert.equal(withdrawalApplication.status, 201);
    assert.equal((await call('POST', `/api/applications/${withdrawalApplication.payload.data._id}/withdraw`, { token: reviewerUser.token })).status, 404);
    const withdrawn = await call('POST', `/api/applications/${withdrawalApplication.payload.data._id}/withdraw`, { token: student.token });
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.payload.data.status, 'withdrawn');
    assert.equal((await call('GET', '/api/applications/me', { token: student.token })).payload.data.length, 2);

    const dashboard = await call('GET', '/api/dashboard', { token: student.token });
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.payload));
    assert.equal(dashboard.payload.data.counts.evidenceItems, 6);
    assert.equal(dashboard.payload.data.counts.tasksCompleted, 1);

    assert.equal((await call('DELETE', `/api/evidence/${unsharedEvidence.payload.data._id}`, { token: student.token })).status, 200);
    assert.equal((await call('DELETE', `/api/evidence/${evidence.payload.data._id}`, { token: student.token })).status, 200);
    const profileAfterArchive = await call('GET', '/api/profile/me', { token: student.token });
    assert.deepEqual(profileAfterArchive.payload.data.profile.skills[0].evidenceIds, []);
    assert.equal((await call('GET', '/api/evidence/me', { token: student.token })).payload.data.length, 4);
    assert.equal((await call('GET', '/api/dashboard', { token: student.token })).payload.data.counts.evidenceItems, 4);
    assert.equal((await call('DELETE', `/api/projects/${project.payload.data._id}`, { token: student.token })).status, 200);
    assert.equal((await call('GET', '/api/projects/me', { token: student.token })).payload.data.length, 0);
    assert.equal((await call('DELETE', `/api/projects/${otherProject.payload.data._id}`, { token: reviewerUser.token })).status, 200);
    assert.equal((await call('GET', '/api/projects/me', { token: reviewerUser.token })).payload.data.length, 0);
    assert.equal((await call('DELETE', `/api/opportunities/${opportunityId}`, { token: founder.token })).status, 200);
    assert.equal((await call('GET', '/api/opportunities', { token: student.token })).payload.data.length, 1);
    assert.equal((await call('DELETE', `/api/opportunities/${withdrawalOpportunity.payload.data._id}`, { token: adminToken })).status, 200);
    assert.equal((await call('GET', '/api/opportunities', { token: student.token })).payload.data.length, 0);
    assert.equal((await call('DELETE', `/api/briefs/${briefId}`, { token: founder.token })).status, 200);
    assert.equal((await call('GET', `/api/tasks/${briefTaskId}`, { token: student.token })).status, 404);
    const archivedTask = await call('DELETE', `/api/admin/tasks/${taskId}`, { token: adminToken });
    assert.equal(archivedTask.status, 200);
    assert.equal(archivedTask.payload.data.status, 'archived');
    assert.equal((await call('GET', '/api/tasks', { token: student.token })).payload.data.length, 0);
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
