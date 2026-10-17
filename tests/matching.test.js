import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMatch, getMatchingWeights, getSkillGapRecommendations } from '../src/services/matching.service.js';

test('matching normalizes skills and explains all three score components', () => {
  const result = calculateMatch(
    { skills: [{ name: '  RESEARCH  ' }] },
    [{ _id: 'evidence-1', title: 'Research interview notes' }],
    { requiredSkills: ['research', 'Writing'], eligibility: [] },
    0.75,
  );
  assert.equal(result.score, 70);
  assert.deepEqual(result.matchedSkills, ['research']);
  assert.deepEqual(result.missingSkills, ['writing']);
  assert.deepEqual(result.evidenceIds, ['evidence-1']);
  assert.match(result.explanation, /reviewer rubric performance 75%/);
  assert.equal(result.eligibility.eligible, true);
});

test('mandatory eligibility is separate from the score', () => {
  const result = calculateMatch(
    { skills: [{ name: 'Research' }], location: 'Delhi' },
    [],
    { requiredSkills: ['Research'], eligibility: ['Must have location: Mumbai'] },
  );
  assert.equal(result.score, 50);
  assert.equal(result.eligibility.eligible, false);
  assert.equal(result.eligibility.failures.length, 1);
});

test('unknown eligibility rules require manual review instead of passing silently', () => {
  const result = calculateMatch(
    { skills: [] },
    [],
    { requiredSkills: [], eligibility: ['Must be available on weekdays'] },
  );
  assert.equal(result.eligibility.eligible, false);
  assert.equal(result.eligibility.status, 'needs_review');
  assert.deepEqual(result.eligibility.unverified, ['Must be available on weekdays']);
});

test('rejected and changes-requested evidence does not contribute to a match', () => {
  const result = calculateMatch(
    { skills: [{ name: 'Research' }] },
    [
      { _id: 'rejected', title: 'Research notes', status: 'rejected' },
      { _id: 'changes', title: 'Research interviews', status: 'changes_requested' },
    ],
    { requiredSkills: ['Research'], eligibility: [] },
  );
  assert.equal(result.score, 50);
  assert.deepEqual(result.evidenceIds, []);
});

test('seeded sample evidence is excluded from a candidate match', () => {
  const result = calculateMatch(
    { skills: [{ name: 'Research' }] },
    [{ _id: 'sample', title: 'Research task', skills: ['Research'], provenance: 'sample' }],
    { requiredSkills: ['Research'], eligibility: [] },
  );
  assert.equal(result.score, 50);
  assert.deepEqual(result.evidenceIds, []);
});

test('matching weights can be configured but must sum to 100', () => {
  assert.deepEqual(getMatchingWeights({ MATCH_SKILL_WEIGHT: '40', MATCH_EVIDENCE_WEIGHT: '35', MATCH_TASK_WEIGHT: '25' }), { skills: 40, evidence: 35, performance: 25 });
  assert.throws(() => getMatchingWeights({ MATCH_SKILL_WEIGHT: '45', MATCH_EVIDENCE_WEIGHT: '30', MATCH_TASK_WEIGHT: '20' }), /sum to 100/);
});

test('skill gap recommendations suggest published public practice tasks only', () => {
  const result = getSkillGapRecommendations(
    { skills: [{ name: ' Research ' }] },
    { requiredSkills: ['Research', 'Data Analysis', 'Communication'] },
    [
      { _id: 'private', title: 'Private brief', requiredSkills: ['Data Analysis'], status: 'published', visibility: 'invite_only' },
      { _id: 'draft', title: 'Draft', requiredSkills: ['Communication'], status: 'draft', visibility: 'public' },
      { _id: 'public', title: 'Data analysis basics', requiredSkills: ['DATA ANALYSIS'], status: 'published', visibility: 'public' },
    ],
  );
  assert.deepEqual(result.missingSkills, ['data analysis', 'communication']);
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].id, 'public');
  assert.match(result.note, /does not automatically add or verify a skill/);
});
