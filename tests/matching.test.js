import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMatch } from '../src/services/matching.service.js';

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
