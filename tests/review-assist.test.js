import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestRubricScores } from '../src/services/review-assist.service.js';

const task = { title: 'Research summary', goal: 'Summarize sources.', description: 'Use the provided material.', rubric: [{ criterion: 'Evidence', points: 6, description: 'Sources are relevant.' }, { criterion: 'Clarity', points: 4, description: 'Writing is clear.' }] };
const submission = { deliverables: [{ name: 'Summary', value: 'A short research summary.' }] };

test('review assistance without Gemini returns no fabricated scores', async () => {
  const result = await suggestRubricScores(task, submission, { apiKey: '' });
  assert.equal(result.source, 'sample');
  assert.deepEqual(result.scores, []);
});

test('review assistance validates rubric coverage and bounded scores', async () => {
  class ValidClient { models = { generateContent: async () => ({ text: JSON.stringify({ scores: [{ criterion: 'Evidence', score: 5, rationale: 'Sources address the question.' }, { criterion: 'Clarity', score: 3, rationale: 'The explanation is understandable.' }], summary: 'Promising work.' }) }) }; }
  const result = await suggestRubricScores(task, submission, { apiKey: 'test-key', clientClass: ValidClient });
  assert.equal(result.source, 'gemini');
  assert.deepEqual(result.scores.map(({ criterion, maxScore }) => ({ criterion, maxScore })), [{ criterion: 'Evidence', maxScore: 6 }, { criterion: 'Clarity', maxScore: 4 }]);

  class InvalidClient { models = { generateContent: async () => ({ text: JSON.stringify({ scores: [{ criterion: 'Evidence', score: 99, rationale: 'Invalid range.' }, { criterion: 'Evidence', score: 2, rationale: 'Duplicate criterion.' }], summary: 'Invalid.' }) }) }; }
  const fallback = await suggestRubricScores(task, submission, { apiKey: 'test-key', clientClass: InvalidClient });
  assert.equal(fallback.source, 'sample');
  assert.deepEqual(fallback.scores, []);
});
