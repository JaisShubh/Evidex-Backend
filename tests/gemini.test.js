import test from 'node:test';
import assert from 'node:assert/strict';
import { deconstructIdea } from '../src/services/gemini.service.js';

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
