import { OxyInferenceClient } from '@oxy.so/core/inference';
import { config } from '../../config';
import { canAuthenticateAsService } from '../../runtime/serviceIdentity';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { createJevShadowEvaluation } from './jevSdk';
import { isJevShadowReleased, ShadowAdmissionClosedError, type ShadowEvaluation } from './jevShadow';
import { MENTION_JEV_APPLICATION_ID, reviewedMentionJevProduction } from './jevProductionApproval';

/** The real product factory stays inert while any independent release gate is absent. */
export function createProductionJevEvaluation(): ShadowEvaluation | undefined {
  if (!isJevShadowReleased()) return undefined;
  const approval = reviewedMentionJevProduction();
  if (!approval) return undefined;
  const expiresAt = Date.parse(approval.validUntil);
  if (approval.scope !== 'native-original-public'
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
  const evaluation = createJevShadowEvaluation(client, approval.release, approval.topics, approval.authority);
  const isAdmissionOpen = () => isJevShadowReleased() && Date.now() < expiresAt;
  return { ...evaluation, isAdmissionOpen, async evaluate(input) {
    if (!isAdmissionOpen()) {
      throw new ShadowAdmissionClosedError('Mention Jev production approval is no longer active');
    }
    return evaluation.evaluate(input);
  } };
}
