import { buildJevDecisionRequest, jevInputSha256 } from './jevRequest';
import { OxyInferenceClient } from '@oxy.so/core/inference';
import { config } from '../../config';
import { canAuthenticateAsService } from '../../runtime/serviceIdentity';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { createJevShadowEvaluation } from './jevSdk';
import { isJevShadowReleased, shadowSelectionSchema, ShadowAdmissionClosedError, type ShadowEvaluation } from './jevShadow';
import { MENTION_JEV_APPLICATION_ID, reviewedMentionJevProduction } from './jevProductionApproval';

/** The real product factory stays inert while any independent release gate is absent. */
export function createProductionJevEvaluation(): ShadowEvaluation | undefined {
  if (!isJevShadowReleased()) return undefined;
  const approval = reviewedMentionJevProduction();
  if (!approval) return undefined;
  const expiresAt = Date.parse(approval.validUntil);
  if (!shadowSelectionSchema.safeParse(approval.selection).success
    || approval.scope !== 'native-original-public'
    || approval.authority.applicationId !== MENTION_JEV_APPLICATION_ID
    || approval.authority.environment !== 'production'
    || approval.authority.delegatedUserId !== undefined
    || !approval.deploymentId.trim() || !approval.evidenceRef.trim()
    || !Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== approval.validUntil
    || expiresAt <= Date.now()) {
    throw new Error('Mention Jev production approval is invalid or expired');
  }
  if (!canAuthenticateAsService()) return undefined;
  const client = new OxyInferenceClient({ baseURL: config.oxyApiUrl,
    credential: () => getServiceOxyClient().serviceToken(),
  });
  const selection = Object.freeze({ ...approval.selection });
  const topics = Object.freeze(approval.topics.map(topic => Object.freeze({ ...topic })));
  const evaluation = createJevShadowEvaluation(client, approval.release, topics, approval.authority);
  const selectedOperation = Object.freeze({ selection, topics, expiresAt: approval.validUntil });
  const isAdmissionOpen = () => isJevShadowReleased() && Date.now() < expiresAt;
  return { ...evaluation, selectedOperation, isAdmissionOpen, async evaluate(input) {
    if (!isAdmissionOpen()) {
      throw new ShadowAdmissionClosedError('Mention Jev production approval is no longer active');
    }
    if (input.idempotencyKey !== selection.idempotencyKey
      || jevInputSha256(buildJevDecisionRequest(evaluation.release, topics, input.text, input.languages)) !== selection.inputSha256) {
      throw new ShadowAdmissionClosedError('Mention Jev operation differs from the reviewed selection');
    }
    return evaluation.evaluate(input);
  } };
}
