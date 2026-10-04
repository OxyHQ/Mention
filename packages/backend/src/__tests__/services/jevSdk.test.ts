import { describe, expect, it, vi } from 'vitest';
import { OxyInferenceClient } from '@oxy.so/core/inference';
import type { DecisionRequest, DecisionSuccess } from '@oxy.so/contracts';
import { createJevShadowEvaluation } from '../../services/contentClassification/jevSdk';

const release = { model: 'synthetic/jev@fixture-v1', policyRef: 'fixture-policy',
  policyVersion: 1, evaluationVersion: 'shadow-v1', supportedLanguages: ['en', 'es'] };
const topics = [{ topic: 'science', question: 'Is this about science?' },
  { topic: 'news', question: 'Is this news?' }];
const input = { text: 'Synthetic science news', languages: ['en', 'es'],
  idempotencyKey: 'owned-claim', signal: new AbortController().signal };
function response(request: DecisionRequest): DecisionSuccess {
  return { schemaVersion: 1, requestId: 'oxy-request', model: request.model,
    routingPolicy: { routingPolicyId: release.policyRef, policyVersion: release.policyVersion }, usage: [{ unit: 'requests', quantity: 1 }, { unit: 'input_tokens', quantity: 17 }],
    data: request.questions.map(question => question.kind === 'score'
      ? { id: question.id, kind: 'score', reply: 3, mean: 3, confidence: 0.5, distribution: [0, 0, 0, 1, 0] }
      : { id: question.id, kind: 'noul', probability: question.id === 'spam' ? 0.1 : 0.9 }),
  };
}
function fixture(mutate: (result: DecisionSuccess) => unknown = result => result) {
  // Exercise the public SDK with an in-memory fetch double, never a provider.
  const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as DecisionRequest;
    return new Response(JSON.stringify(mutate(response(request))), {
      headers: { 'Content-Type': 'application/json', 'X-Oxy-Request-Id': 'oxy-request' },
    });
  });
  const client = new OxyInferenceClient({ credential: 'synthetic-only', fetch: transport });
  return { transport, evaluation: createJevShadowEvaluation(client, release, topics) };
}

describe('published Jev SDK consumer', () => {
  it('refuses a configured recovery authority without a canonical reader before any inference', () => {
    const decide = vi.fn();
    expect(() => createJevShadowEvaluation({ decide }, release, topics,
      { applicationId: 'fixture', credentialId: 'fixture', environment: 'production' })).toThrow('Canonical receipt reader is unavailable');
    expect(decide).not.toHaveBeenCalled();
  });

  it('uses independent propositions, ordered score and actual SDK request/policy references', async () => {
    const { evaluation, transport } = fixture(result => ({ ...result, data: [...result.data].reverse() }));
    const result = await evaluation.evaluate(input);
    expect(result.topics.map(topic => topic.probability)).toEqual([0.9, 0.9]);
    expect(result.spam).toBe(0.1);
    expect(result.repetition).toBe(0.9);
    expect(result.feedValue).toBe(0.75);
    expect(result.languageEvidence).toEqual([{ language: 'en', probability: 0.9 }, { language: 'es', probability: 0.9 }]);
    expect(result.sdkReceipt).toEqual({ requestId: 'oxy-request',
      routingPolicy: { routingPolicyId: 'fixture-policy', policyVersion: 1 },
      usage: [{ unit: 'requests', quantity: 1 }, { unit: 'input_tokens', quantity: 17 }] });
    const init = transport.mock.calls[0]?.[1];
    const request = JSON.parse(String(init?.body)) as DecisionRequest;
    expect(request.questions.map(question => [question.id, question.kind])).toEqual([
      ['topic:0', 'noul'], ['topic:1', 'noul'], ['spam', 'noul'], ['repetition', 'noul'],
      ['language:0', 'noul'], ['language:1', 'noul'], ['feedScore', 'score'],
    ]);
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(input.idempotencyKey);
    expect(init?.signal).toBe(input.signal);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  const invalid: Array<[string, (result: DecisionSuccess) => unknown]> = [
    ['model', result => ({ ...result, model: 'synthetic/jev@other' })],
    ['request ID/header mismatch', result => ({ ...result, requestId: 'wrong' })],
    ['empty request ID', result => ({ ...result, requestId: '' })],
    ['policy ID', result => ({ ...result, routingPolicy: { ...result.routingPolicy, routingPolicyId: 'other' } })],
    ['policy version', result => ({ ...result, routingPolicy: { ...result.routingPolicy, policyVersion: 2 } })],
    ['missing usage', result => ({ ...result, usage: undefined })],
    ['invalid usage', result => ({ ...result, usage: [{ unit: 'requests', quantity: -1 }] })],
    ['invented billing receipt', result => ({ ...result, receiptId: 'invented' })],
    ['missing receipt', result => ({ ...result, routingPolicy: undefined })],
    ['unknown envelope field', result => ({ ...result, invented: true })],
    ['missing answer', result => ({ ...result, data: result.data.slice(1) })],
    ['extra answer', result => ({ ...result, data: [...result.data, { id: 'extra', kind: 'noul', probability: 0.5 }] })],
    ['duplicate ID', result => ({ ...result, data: result.data.map((answer, index) => index === 1 ? result.data[0] : answer) })],
    ['wrong ID', result => ({ ...result, data: result.data.map((answer, index) => index === 0 ? { ...answer, id: 'other' } : answer) })],
    ['wrong kind', result => ({ ...result, data: result.data.map(answer => answer.id === 'spam'
      ? { id: 'spam', kind: 'choice', reply: 'yes', confidence: 0.9, probabilities: [0.9, 0.1] } : answer) })],
    ['bad probability', result => ({ ...result, data: result.data.map(answer => answer.kind === 'noul' ? { ...answer, probability: 2 } : answer) })],
    ['score cardinality', result => ({ ...result, data: result.data.map(answer => answer.kind === 'score'
      ? { ...answer, distribution: [0, 0, 0, 1] } : answer) })],
    ['score mean', result => ({ ...result, data: result.data.map(answer => answer.kind === 'score' ? { ...answer, mean: 2 } : answer) })],
    ['score normalization', result => ({ ...result, data: result.data.map(answer => answer.kind === 'score'
      ? { ...answer, distribution: [0, 0, 0, 0.5, 0] } : answer) })],
  ];
  it.each(invalid)('rejects %s with no second dispatch', async (_name, mutate) => {
    const { evaluation, transport } = fixture(mutate);
    await expect(evaluation.evaluate(input)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('abstains before dispatch for unsupported, missing or duplicate languages', async () => {
    const { evaluation, transport } = fixture();
    for (const languages of [['ja'], [], ['en', 'en']]) {
      await expect(evaluation.evaluate({ ...input, languages })).rejects.toThrow();
    }
    expect(transport).not.toHaveBeenCalled();
  });
});
