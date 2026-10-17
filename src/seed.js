import 'dotenv/config';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDatabase } from './config/database.js';
import { User } from './models/User.js';
import { Task, Attempt, Submission, Evidence, VerificationRun } from './models/Work.js';
import { Idea, IdeaAnalysis, Experiment, Opportunity } from './models/Venture.js';
import { sampleAnalysis } from './services/gemini.service.js';

try {
  await connectDatabase();
  await Task.updateOne(
    { title: 'Customer discovery mini study' },
    { $setOnInsert: {
      title: 'Customer discovery mini study',
      goal: 'Practice gathering behavioral evidence before building a solution.',
      description: 'Interview three people who may experience a problem you care about. Ask about the last time it happened, current workarounds, and consequences. Do not pitch a solution during the first half.',
      category: 'Research', difficulty: 'Beginner', requiredSkills: ['Research', 'Communication'],
      deliverables: [{ name: 'Interview notes', required: true }, { name: 'Pattern summary', required: true }, { name: 'Reflection', required: true }],
      rubric: [
        { criterion: 'Behavior-focused questions', points: 30, description: 'Questions invite concrete recent examples.' },
        { criterion: 'Evidence synthesis', points: 40, description: 'Summary separates observations from interpretation.' },
        { criterion: 'Limitations', points: 30, description: 'Notes sample and context limitations.' },
      ],
      allowedTools: 'Any tools; disclose AI assistance.', version: 1, status: 'published',
    } },
    { upsert: true },
  );

  for (const item of [
    { title: 'Junior Product Researcher Trial', provider: 'EVIDEX demo opportunity', description: 'A sample opportunity for practicing user research.', requiredSkills: ['Research', 'Communication'], eligibility: [], remote: true },
    { title: 'Frontend Prototype Contributor', provider: 'EVIDEX demo opportunity', description: 'A sample opportunity for building accessible interfaces.', requiredSkills: ['React', 'Accessibility'], eligibility: [], remote: true },
  ]) {
    await Opportunity.updateOne({ title: item.title }, { $setOnInsert: { ...item, status: 'published' } }, { upsert: true });
  }

  if (!process.env.DEMO_USER_PASSWORD) {
    console.log('Demo account and sample idea skipped. Set DEMO_USER_PASSWORD in .env to seed them.');
  } else {
    if (process.env.DEMO_USER_PASSWORD.length < 10) throw new Error('DEMO_USER_PASSWORD must be at least 10 characters.');
    const email = (process.env.DEMO_USER_EMAIL || 'demo@evidex.local').toLowerCase();
    const existingUser = await User.findOne({ email });
    if (existingUser && existingUser.name !== 'EVIDEX Demo User') {
      throw new Error('DEMO_USER_EMAIL already belongs to a non-demo account; choose a separate demo email.');
    }
    const user = existingUser || await User.create({
      email,
      name: 'EVIDEX Demo User',
      passwordHash: await bcrypt.hash(process.env.DEMO_USER_PASSWORD, 12),
      role: 'student',
      profile: {
        displayName: 'EVIDEX Demo User',
        bio: 'DEMO PROFILE — sample data, not a real candidate.',
        preferredRole: 'Product researcher',
        visibility: 'private',
        skills: [{ name: 'Research', proficiency: 'intermediate' }, { name: 'Communication', proficiency: 'beginner' }],
      },
    });
    const idea = await Idea.findOneAndUpdate(
      { userId: user.id, title: 'Sample idea: Community tool library' },
      { $setOnInsert: { userId: user.id, title: 'Sample idea: Community tool library', description: 'A clearly labelled sample idea for learning how assumptions and experiments are stored.', targetCustomer: 'Example only — not validated research.', problem: 'Do neighbors need easier access to occasional-use tools?', proposedSolution: 'A shared catalog and reservation process.', status: 'test_planned' } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    await IdeaAnalysis.updateOne(
      { ideaId: idea.id, source: 'sample' },
      { $setOnInsert: { ideaId: idea.id, userId: user.id, source: 'sample', schemaVersion: '1', ...sampleAnalysis } },
      { upsert: true },
    );
    for (const item of sampleAnalysis.experiments) {
      await Experiment.updateOne(
        { ideaId: idea.id, hypothesis: item.hypothesis },
        { $setOnInsert: { ...item, ideaId: idea.id, userId: user.id, status: 'planned', version: 1 } },
        { upsert: true },
      );
    }
    const task = await Task.findOne({ title: 'Customer discovery mini study' });
    const attempt = await Attempt.findOneAndUpdate(
      { userId: user.id, taskId: task.id, isSample: true },
      { $setOnInsert: { userId: user.id, taskId: task.id, taskVersion: task.version, isSample: true, status: 'needs_review' } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    const submission = await Submission.findOneAndUpdate(
      { attemptId: attempt.id, isSample: true },
      { $setOnInsert: {
        attemptId: attempt.id, userId: user.id, version: 1, isSample: true, status: 'needs_review',
        notes: 'SAMPLE SUBMISSION — fictional demonstration content, not real candidate work.',
        deliverables: task.deliverables.map((item) => ({ name: item.name, value: 'Sample only — no interviews or real-world observations were performed.' })),
      } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    await VerificationRun.updateOne(
      { submissionId: submission.id },
      { $setOnInsert: { submissionId: submission.id, checks: [{ name: 'Sample record', status: 'needs_review', meaning: 'Demonstration content only; no work was assessed.' }], results: { overallStatus: 'needs_review' }, warnings: ['This is seeded sample data, not a verified submission.'] } },
      { upsert: true },
    );
    await Evidence.updateOne(
      { relatedSubmissionId: submission.id },
      { $setOnInsert: { userId: user.id, type: 'task_submission', title: 'Sample task submission — not a real candidate', skills: task.requiredSkills, relatedSubmissionId: submission.id, provenance: 'sample', status: 'needs_review' } },
      { upsert: true },
    );
    console.log(`Demo account seeded for ${email}; use the password configured in .env. Sample idea, analysis, submission, and evidence are labelled and include no claimed outcomes.`);
  }
  console.log('Demo task and two opportunities are ready. No reviews, customer interviews, or employment outcomes are fabricated.');
} finally {
  await mongoose.disconnect();
}
