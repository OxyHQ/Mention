import { buildJevDecisionRequest, jevInputSha256 } from '../../services/contentClassification/jevRequest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '@oxy.so/contracts';
import * as approvalSource from '../../services/contentClassification/jevProductionApproval';
import * as gates from '../../services/contentClassification/jevShadow';
import { createProductionJevEvaluation } from '../../services/contentClassification/jevProduction';

const { identity, token } = vi.hoisted(() => ({ identity: vi.fn(), token: vi.fn() }));
vi.mock('../../runtime/serviceIdentity', () => ({ canAuthenticateAsService: () => identity() }));
vi.mock('../../utils/oxyHelpers', () => ({ getServiceOxyClient: () => ({ serviceToken: token }) }));

function approval(): approvalSource.MentionJevProductionApproval {
  const release = { model: 'synthetic/jev@fixture-v1', policyRef: 'fixture-policy', policyVersion: 1, evaluationVersion: 'fixture-v1', supportedLanguages: ['en'] };
  return { selection: { postId: 'synthetic-post', fingerprint: 'a'.repeat(64), idempotencyKey: input.idempotencyKey,
    inputSha256: jevInputSha256(buildJevDecisionRequest(release, [], input.text, input.languages)) }, scope: 'native-original-public', ownerAccountId: approvalSource.MENTION_JEV_OWNER_ACCOUNT_ID, reviews: { publishedSdk: 'fixture:sdk', exactPrivateRoute: 'fixture:route', ownAuthorityAndEconomics: 'fixture:authority', privacyAndZdr: 'fixture:privacy', semanticIdentityAndRecovery: 'fixture:recovery' }, deploymentId: 'synthetic-deployment', provider: 'fixture-provider', priceVersionId: 'fixture-price', evidenceRef: 'fixture:only',
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    authority: { applicationId: approvalSource.MENTION_JEV_APPLICATION_ID, credentialId: approvalSource.MENTION_JEV_WORKLOAD_CREDENTIAL_ID, environment: 'production' },
    release: { model: 'synthetic/jev@fixture-v1', policyRef: 'fixture-policy', policyVersion: 1,
      evaluationVersion: 'fixture-v1', supportedLanguages: ['en'] }, topics: [], };
}
const input = { text: 'Synthetic native public post', languages: ['en'], idempotencyKey: 'original-claim', signal: new AbortController().signal };
beforeEach(() => { identity.mockReturnValue(true); token.mockResolvedValue('synthetic-only'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Mention production factory', () => {
  it('never creates authority from environment or Alia when source admission is absent', () => {
    vi.spyOn(approvalSource, 'reviewedMentionJevProduction').mockReturnValue(undefined);
    expect(approvalSource.reviewedMentionJevProduction()).toBeUndefined();
    expect(createProductionJevEvaluation()).toBeUndefined();
    expect(identity).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
    vi.spyOn(gates, 'isJevShadowReleased').mockReturnValue(true);
    expect(createProductionJevEvaluation()).toBeUndefined();
    expect(identity).not.toHaveBeenCalled();
  });
  it('returns only the reviewed own native selection until the exact source deadline and isolates caller mutations', () => {
    const deadline = Date.parse('2026-10-05T07:09:12.000Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline - 1);
    const reviewed = approvalSource.reviewedMentionJevProduction();
    if (!reviewed) throw new Error('reviewed native source unexpectedly absent');
    expect(reviewed.authority).toEqual({ applicationId: approvalSource.MENTION_JEV_APPLICATION_ID,
      credentialId: approvalSource.MENTION_JEV_WORKLOAD_CREDENTIAL_ID, environment: 'production' });
    expect(reviewed.ownerAccountId).toBe(approvalSource.MENTION_JEV_OWNER_ACCOUNT_ID);
    expect(reviewed.scope).toBe('native-original-public');
    expect(reviewed.selection.idempotencyKey).toBe('mention_jev_native_en_9aebfe5269e8fbe9e8c3961a93ef71d3');
    expect(reviewed.selection.postId).toBe('019fd378-8ea7-7b4f-acd0-1c83361e0413');
    expect(reviewed.release.supportedLanguages).toEqual(['en']); expect(reviewed.topics).toEqual([]);
    expect(reviewed.selection.fingerprint).toBe('b6118a879b0961cf1c25c040ea501ef7e4557228bea5f4f82dac2efa2e684222');
    expect(reviewed.selection.inputSha256).toBe('0c12c43c70a269a40ca0e856af98c48db8d20573b2e1b7d75f9bd6f9468a73da');
    expect(reviewed.deploymentId).toBe('dep_openrouter_typesafe_jev_1_13_mention_native_third_2026_10_05');
    expect(reviewed.priceVersionId).toBe('jev_scoped_price_20261004_01');
    for (const consumedKey of ['mention_jev_native_en_8d04b9d17510fe89d7ae084039ee4231', 'mention_jev_native_en_d5c4e4815e9bfb2b998af67bb7677011']) {
      expect(reviewed.selection.idempotencyKey).not.toBe(consumedKey);
    }
    expect(reviewed.release.evaluationVersion).toBe('mention-native-en-onepost/2026-10-05.1');
    expect(reviewed.reviews).toEqual({
  "publishedSdk": "sha256:3fd42da244ee12af5d9017629f0c8eb75796e8ce04de735597cf8d01f7b51a2c",
  "exactPrivateRoute": "sha256:6f42d4dc5781eef5e21921ea97ff104baefe0605f6642038ce3a7d16769e9c6f",
  "ownAuthorityAndEconomics": "sha256:af2c5aabe1e316b5b1e4ffbdb92a01498dc43f59e5acaaba522de5a9faf7b35d",
  "privacyAndZdr": "sha256:54ed54b431a55cb678e8f4d47af6c15f648a8c98f5d22f5ab3fc81e76c76861a",
  "semanticIdentityAndRecovery": "sha256:6cbcbc7f98cba69ef614daf3595e27b3bcec0b3c2d0a6a0b3a18bd4fe65b73fe"
});
    expect(Object.keys(reviewed.reviews).sort()).toEqual([...approvalSource.MENTION_NATIVE_JEV_CONTROLS].sort());
    expect(Object.values(reviewed.reviews).every(ref => /^sha256:[a-f0-9]{64}$/.test(ref))).toBe(true);
    expect(createProductionJevEvaluation()?.selectedOperation?.selection).toEqual(reviewed.selection);
    Object.assign(reviewed.selection, { postId: 'foreign-post', idempotencyKey: 'foreign-key' });
    Object.assign(reviewed.authority, { applicationId: 'borrowed-alia' });
    expect(approvalSource.reviewedMentionJevProduction()?.selection.postId).toBe('019fd378-8ea7-7b4f-acd0-1c83361e0413');
    expect(approvalSource.reviewedMentionJevProduction()?.authority.applicationId).toBe(approvalSource.MENTION_JEV_APPLICATION_ID);
    clock.mockReturnValue(deadline);
    expect(approvalSource.reviewedMentionJevProduction()).toBeUndefined();
    expect(createProductionJevEvaluation()).toBeUndefined();
    clock.mockReturnValue(deadline + 1);
    expect(approvalSource.reviewedMentionJevProduction()).toBeUndefined();
    expect(token).not.toHaveBeenCalled();
  });
  it('does not create a client without the existing workload identity', () => {
    vi.spyOn(gates, 'isJevShadowReleased').mockReturnValue(true);
    vi.spyOn(approvalSource, 'reviewedMentionJevProduction').mockReturnValue(approval());
    identity.mockReturnValue(false);
    expect(createProductionJevEvaluation()).toBeUndefined(); expect(token).not.toHaveBeenCalled();
  });
  it.each(['app', 'owner', 'credential', 'reviews', 'environment', 'delegation', 'scope', 'deployment', 'evidence', 'ambiguous-date', 'selection'])(
    'rejects an invalid %s binding before obtaining a credential', kind => {
      const candidate = approval();
      const altered = { ...candidate, authority: { ...candidate.authority } };
      if (kind === 'selection') Object.assign(altered, { selection: undefined });
      if (kind === 'owner') altered.ownerAccountId = 'foreign-owner';
      if (kind === 'credential') altered.authority.credentialId = 'foreign-credential';
      if (kind === 'reviews') Object.assign(altered, { reviews: { ...altered.reviews, privacyAndZdr: '' } });
      if (kind === 'app') altered.authority.applicationId = 'synthetic-alia';
      if (kind === 'environment') altered.authority.environment = 'test';
      if (kind === 'delegation') altered.authority.delegatedUserId = 'borrowed-human';
      if (kind === 'scope') Object.assign(altered, { scope: 'federated-public' });
      if (kind === 'deployment') altered.deploymentId = '';
      if (kind === 'evidence') altered.evidenceRef = '';
      if (kind === 'ambiguous-date') altered.validUntil = '2999-01-01';
      vi.spyOn(gates, 'isJevShadowReleased').mockReturnValue(true);
      vi.spyOn(approvalSource, 'reviewedMentionJevProduction').mockReturnValue(altered);
      expect(() => createProductionJevEvaluation()).toThrow('approval is invalid');
      expect(token).not.toHaveBeenCalled(); expect(identity).not.toHaveBeenCalled();
    });
  it('uses the actual SDK once and leaves receipt GET available when admission expires', async () => {
    const candidate = approval();
    vi.spyOn(gates, 'isJevShadowReleased').mockReturnValue(true);
    vi.spyOn(approvalSource, 'reviewedMentionJevProduction').mockReturnValue(candidate);
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer synthetic-only');
      expect(headers.get('Idempotency-Key')).toBe(input.idempotencyKey);
      expect(headers.get('X-Oxy-User-Id')).toBeNull();
      if (init?.method === 'GET') return new Response('{}', { status: 404 });
      const request = JSON.parse(String(init?.body)) as DecisionRequest;
      expect(request.model).toBe(candidate.release.model);
      return new Response(JSON.stringify({ schemaVersion: 1, requestId: 'owned-request', model: request.model,
        routingPolicy: { routingPolicyId: candidate.release.policyRef, policyVersion: 1 }, usage: [{ unit: 'requests', quantity: 1 }],
        data: request.questions.map(q => q.kind === 'score'
          ? { id: q.id, kind: 'score', reply: 3, mean: 3, confidence: 0.5, distribution: [0, 0, 0, 1, 0] }
          : { id: q.id, kind: 'noul', probability: 0.1 }) }), { headers: { 'X-Oxy-Request-Id': 'owned-request' } });
    });
    vi.stubGlobal('fetch', transport);
    const evaluation = createProductionJevEvaluation()!;
    expect((await evaluation.evaluate(input)).sdkReceipt.requestId).toBe('owned-request');
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(candidate.validUntil));
    await expect(evaluation.evaluate(input)).rejects.toThrow('no longer active');
    await expect(evaluation.receiptReader!.readOriginal(input.idempotencyKey, candidate.release.model)).rejects.toThrow();
    expect(transport.mock.calls.map(call => call[1]?.method)).toEqual(['POST', 'GET']);
  });
  it.each(['key', 'text', 'language'] as const)('rejects changed selected %s before credentials or HTTP', async kind => {
    vi.spyOn(gates, 'isJevShadowReleased').mockReturnValue(true);
    vi.spyOn(approvalSource, 'reviewedMentionJevProduction').mockReturnValue(approval());
    const transport = vi.fn(); vi.stubGlobal('fetch', transport);
    const evaluation = createProductionJevEvaluation()!;
    const changed = { ...input };
    if (kind === 'key') changed.idempotencyKey = 'foreign-key';
    if (kind === 'text') changed.text += ' changed';
    if (kind === 'language') changed.languages = ['fr'];
    await expect(evaluation.evaluate(changed)).rejects.toThrow();
    expect(token).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });

});
