import { describe, expect, it, mock } from 'bun:test';
import { Kaana } from '@kaana.ai/sdk';
import type { DecisionRequest, DecisionSuccess } from '@kaana.ai/contracts';
import { createJevShadowEvaluation } from '../../services/contentClassification/jevSdk';

const release = { evaluationVersion: 'shadow-v1', supportedLanguages: ['en', 'es'] };
const topics = [
  { topic: 'science', question: 'Is this about science?' },
  { topic: 'news', question: 'Is this news?' },
];
const input = {
  text: 'Synthetic science news',
  languages: ['en', 'es'],
  idempotencyKey: 'owned-claim',
  signal: new AbortController().signal,
};
const served = 'synthetic/jev@observed-fixture';

function answer(request: DecisionRequest): DecisionSuccess {
  return {
    schemaVersion: 1,
    requestId: 'kaana-request',
    model: served,
    routingPolicy: { routingPolicyId: 'fixture-policy', policyVersion: 1 },
    usage: [{ unit: 'input_tokens', quantity: 17 }],
    data: request.questions.map((question) =>
      question.kind === 'score'
        ? {
            id: question.id,
            kind: 'score',
            reply: 3,
            mean: 3,
            confidence: 0.5,
            distribution: [0, 0, 0, 1, 0],
          }
        : { id: question.id, kind: 'noul', probability: question.id === 'spam' ? 0.1 : 0.9 },
    ),
  };
}

/** The real SDK over an in-memory fetch double: no provider, no network. */
function fixture(respond: (init: RequestInit) => unknown) {
  const transport = mock(async (_url: string, init: RequestInit) =>
    Response.json(respond(init), { headers: { 'Kaana-Request-Id': 'kaana-request' } }),
  );
  const kaana = new Kaana({ credential: 'synthetic-only', fetch: transport, maxRetries: 0 });
  return { transport, evaluation: createJevShadowEvaluation(kaana, release, topics) };
}

describe('Jev decisions consumer', () => {
  it('asks once with no model and keeps the model that answered', async () => {
    const { evaluation, transport } = fixture((init) =>
      answer(JSON.parse(String(init.body)) as DecisionRequest),
    );
    const result = await evaluation.evaluate(input);
    expect(result).toMatchObject({
      resolvedModel: served,
      spam: 0.1,
      repetition: 0.9,
      feedValue: 0.75,
      topics: [
        { topic: 'science', probability: 0.9 },
        { topic: 'news', probability: 0.9 },
      ],
      sdkReceipt: {
        requestId: 'kaana-request',
        routingPolicy: { routingPolicyId: 'fixture-policy', policyVersion: 1 },
      },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const init = transport.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('model');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(input.idempotencyKey);
  });

  it('refuses answers to other questions, with no second dispatch', async () => {
    const { evaluation, transport } = fixture((init) => {
      const success = answer(JSON.parse(String(init.body)) as DecisionRequest);
      return { ...success, data: success.data.slice(1) };
    });
    await expect(evaluation.evaluate(input)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('abstains before dispatch for an unsupported language', async () => {
    const { evaluation, transport } = fixture(() => ({}));
    await expect(evaluation.evaluate({ ...input, languages: ['ja'] })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('recovers the original usage by the claim key', async () => {
    const { evaluation, transport } = fixture(() => ({
      schemaVersion: 1,
      kind: 'metered_usage',
      meteredUsageId: 'owned-usage',
      requestId: 'original-request',
      applicationId: 'owned-app',
      credentialId: 'owned-credential',
      environment: 'production',
      customerCharge: { status: 'not_charged' },
      tariff: { status: 'unpriced', priceVersionId: null },
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: [{ unit: 'input_tokens', quantity: 17 }],
      model: served,
      settledAt: '2026-10-04T00:00:00.000Z',
    }));
    const recovered = await evaluation.receiptReader?.readOriginal(input.idempotencyKey);
    expect(recovered).toMatchObject({
      status: 'reconciled_result_missing',
      model: served,
      providerCost: 'unknown',
      economics: { kind: 'internal_usage' },
    });
    const url = new URL(String(transport.mock.calls[0]?.[0]));
    expect(url.searchParams.get('idempotency_key')).toBe(input.idempotencyKey);
  });
});
