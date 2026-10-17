import test from 'node:test';
import assert from 'node:assert/strict';
import { deconstructIdea, draftBusinessBrief } from '../src/services/gemini.service.js';

const idea = { title: 'Sample idea', description: 'A test idea.' };

test('Idea Lab without a Gemini key returns explicitly labelled sample data', async () => {
  const result = await deconstructIdea(idea, { apiKey: '' });
  assert.equal(result.source, 'sample');
  assert.equal(result.model, null);
  assert.equal(result.promptVersion, '1');
  assert.ok(result.data.experiments.length > 0);
});

test('Idea Lab provider failures return sample fallback without leaking provider errors', async () => {
  class FailingGeminiClient {
    models = { generateContent: async () => { throw new Error('private provider diagnostic'); } };
  }

  const result = await deconstructIdea(idea, { apiKey: 'test-only-key', clientClass: FailingGeminiClient });
  assert.equal(result.source, 'sample');
  assert.equal(result.fallbackReason, 'provider_unavailable');
  assert.equal(result.model, null);
  assert.doesNotMatch(JSON.stringify(result), /private provider diagnostic/);
});

test('business brief drafting without a Gemini key returns a labelled editable sample', async () => {
  const result = await draftBusinessBrief({ title: 'Research market needs', context: 'Explore how students plan study sessions.' }, { apiKey: '' });
  assert.equal(result.source, 'sample');
  assert.equal(result.model, null);
  assert.equal(result.data.deliverables.length, 1);
  assert.equal(result.data.rubric.reduce((sum, criterion) => sum + criterion.points, 0), 100);
});

test('business brief drafting validates provider output and falls back without leaking errors', async () => {
  class GoodGeminiClient {
    models = { generateContent: async () => ({ text: JSON.stringify({ problem: 'A scoped challenge.', desiredOutcome: 'A clear recommendation.', constraints: 'Synthetic data only.', effortEstimate: 'Two hours', requiredSkills: ['Research'], deliverables: [{ name: 'Plan', required: true, instructions: 'Write a plan.' }], rubric: [{ criterion: 'Clarity', points: 10, description: 'Clear output.' }], allowedTools: 'Any tools.' }) }) };
  }
  const generated = await draftBusinessBrief({ title: 'Test brief', context: 'Test context' }, { apiKey: 'test-key', clientClass: GoodGeminiClient });
  assert.equal(generated.source, 'gemini');
  assert.equal(generated.data.problem, 'A scoped challenge.');

  class FailingGeminiClient {
    models = { generateContent: async () => { throw new Error('private provider diagnostic'); } };
  }
  const fallback = await draftBusinessBrief({ title: 'Test brief', context: 'Test context' }, { apiKey: 'test-key', clientClass: FailingGeminiClient });
  assert.equal(fallback.source, 'sample');
  assert.equal(fallback.fallbackReason, 'provider_unavailable');
  assert.doesNotMatch(JSON.stringify(fallback), /private provider diagnostic/);
});
