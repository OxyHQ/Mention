import type { CapabilityTicketClaims } from '@oxy.so/contracts';
import { createOxyJwksKeyResolver, verifyCapabilityTicket } from '@oxy.so/core/server';
import { config } from '../config';
import { getServiceOxyClient } from '../utils/oxyHelpers';

const resolveKey = createOxyJwksKeyResolver({
  jwksUrl: `${config.oxyApiUrl}/capabilities/.well-known/jwks.json`,
});
/** Signature/issuer/audience first; the route then checks live operation authority. */
export async function verifyMentionCapabilityTicket(
  token: string,
): Promise<CapabilityTicketClaims> {
  if (token.length > 32_768) throw new Error('Capability ticket exceeds size bound');
  const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'));
  const kid: unknown = header?.kid;
  if (typeof kid !== 'string' || !kid || kid.length > 256)
    throw new Error('Capability key id missing');
  const key = await resolveKey(kid);
  return verifyCapabilityTicket(token, {
    audience: config.deploymentMcp.audience,
    issuer: config.oxyApiUrl,
    resolvePublicKey: (requested) => (requested === kid ? key : undefined),
  });
}
/** Shared SDK revalidates the original task/connection and exact live ticket. */
export async function introspectMentionCapabilityTicket(
  token: string,
  localClaims: CapabilityTicketClaims,
): Promise<boolean> {
  const result = await getServiceOxyClient().agency.introspectCapabilityTicket(token);
  return (
    result.active === true &&
    result.decision?.allowed === true &&
    result.claims?.jti === localClaims.jti &&
    result.claims.aud === localClaims.aud &&
    result.claims.tool === localClaims.tool &&
    result.claims.resource.effectiveAccountId === localClaims.resource.effectiveAccountId
  );
}
