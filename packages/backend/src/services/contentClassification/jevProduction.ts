import { createHash } from 'node:crypto';
import { createJevReceiptReader, type ShadowReceiptReader } from './jevReceipt';
import { buildJevDecisionRequest, jevInputSha256 } from './jevRequest';
import { OxyInferenceClient } from '@oxy.so/core/inference';
import { config } from '../../config';
import { canAuthenticateAsService } from '../../runtime/serviceIdentity';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { createJevShadowEvaluation } from './jevSdk';
import { shadowSelectionSchema, ShadowAdmissionClosedError, type ShadowEvaluation } from './jevShadow';
import { MENTION_JEV_APPLICATION_ID, MENTION_JEV_OWNER_ACCOUNT_ID, MENTION_JEV_WORKLOAD_CREDENTIAL_ID, MENTION_NATIVE_JEV_CONTROLS, reviewedMentionJevProduction } from './jevProductionApproval';

const reviewedNativeEvaluations = new WeakSet<ShadowEvaluation>();

/** Only this source-bound factory can admit the selected native operation while broader gates stay closed. */
export function isReviewedNativeJevEvaluation(evaluation: ShadowEvaluation): boolean {
  return reviewedNativeEvaluations.has(evaluation);
}

/** The real product factory stays inert while any independent release gate is absent. */
export function createProductionJevEvaluation(): ShadowEvaluation | undefined {
  const approval = reviewedMentionJevProduction();
  if (!approval) return undefined;
  const expiresAt = Date.parse(approval.validUntil);
  if (!shadowSelectionSchema.safeParse(approval.selection).success
    || approval.scope !== 'native-original-public'
    || approval.ownerAccountId !== MENTION_JEV_OWNER_ACCOUNT_ID
    || approval.authority.applicationId !== MENTION_JEV_APPLICATION_ID
    || approval.authority.credentialId !== MENTION_JEV_WORKLOAD_CREDENTIAL_ID
    || MENTION_NATIVE_JEV_CONTROLS.some(control => typeof approval.reviews?.[control] !== 'string' || !approval.reviews[control].trim())
    || approval.authority.environment !== 'production'
    || approval.authority.delegatedUserId !== undefined
    || !approval.deploymentId.trim() || !approval.provider.trim() || !approval.priceVersionId.trim() || !approval.evidenceRef.trim()
    || !Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== approval.validUntil
) {
    throw new Error('Mention Jev production approval is invalid or expired');
  }
  if (expiresAt <= Date.now()) return undefined;
  if (!canAuthenticateAsService()) return undefined;
  const client = new OxyInferenceClient({ baseURL: config.oxyApiUrl,
    credential: () => getServiceOxyClient().serviceToken(),
  });
  const selection = Object.freeze({ ...approval.selection });
  const topics = Object.freeze(approval.topics.map(topic => Object.freeze({ ...topic })));
  const evaluation = createJevShadowEvaluation(client, approval.release, topics, { ...approval.authority,
    recovery: { version: 1, ownerAccountId: approval.ownerAccountId, deploymentId: approval.deploymentId,
      model: approval.release.model, policyRef: approval.release.policyRef, policyVersion: approval.release.policyVersion,
      evaluationVersion: approval.release.evaluationVersion, provider: approval.provider, priceVersionId: approval.priceVersionId,
      sourceApprovalSha256: createHash('sha256').update(JSON.stringify(approval)).digest('hex'),
      inputSha256: selection.inputSha256, idempotencyKey: selection.idempotencyKey, fingerprint: selection.fingerprint },
  });
  const selectedOperation = Object.freeze({ selection, topics, expiresAt: approval.validUntil });
  const isAdmissionOpen = () => Date.now() < expiresAt;
  const bound: ShadowEvaluation = { ...evaluation, selectedOperation, isAdmissionOpen, async evaluate(input) {
    if (!isAdmissionOpen()) {
      throw new ShadowAdmissionClosedError('Mention Jev production approval is no longer active');
    }
    if (input.idempotencyKey !== selection.idempotencyKey
      || jevInputSha256(buildJevDecisionRequest(evaluation.release, topics, input.text, input.languages)) !== selection.inputSha256) {
      throw new ShadowAdmissionClosedError('Mention Jev operation differs from the reviewed selection');
    }
    return evaluation.evaluate(input);
  } };
  reviewedNativeEvaluations.add(bound);
  return Object.freeze(bound);
}

/** Read-only capability for already-persisted own operations; no source admission or post content. */
export function createProductionJevReceiptReader(): ShadowReceiptReader | undefined {
  if (!canAuthenticateAsService()) return undefined;
  const client = new OxyInferenceClient({ baseURL: config.oxyApiUrl,
    credential: () => getServiceOxyClient().serviceToken(),
  });
  return Object.freeze({ ...createJevReceiptReader(client, { applicationId: MENTION_JEV_APPLICATION_ID,
    credentialId: MENTION_JEV_WORKLOAD_CREDENTIAL_ID, environment: 'production' }),
    recoveryOwnerAccountId: MENTION_JEV_OWNER_ACCOUNT_ID });
}
