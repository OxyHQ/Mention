import { lookupExternalIdentitiesResponseSchema, resolveExternalIdentityResponseSchema } from '@oxy.so/contracts';
import { getServiceOxyClient } from '../utils/oxyHelpers';

/** Oxy verifies the source actor and owns its public identity and profile. */
export async function resolveOxyIdentity(
  input: { handle: string } | { actorUri: string; transportAcct?: string; protocol: 'activitypub' | 'atproto' },
) {
  const response = await getServiceOxyClient().makeServiceRequest<unknown>(
    'POST', '/federation/identities/resolve', input,
  );
  const resolved = resolveExternalIdentityResponseSchema.parse(response);
  if (resolved.externalIdentity.userId !== resolved.user.id
    || ('actorUri' in input && resolved.externalIdentity.actorUri !== input.actorUri)) {
    throw new Error('Oxy returned an inconsistent external identity');
  }
  return resolved;
}

/** Read current Oxy proof without causing source discovery or minting identities. */
export async function lookupOxyIdentities(identifiers: string[]) {
  const response = await getServiceOxyClient().makeServiceRequest<unknown>(
    'POST', '/federation/identities/lookup', { identifiers },
  );
  return lookupExternalIdentitiesResponseSchema.parse(response).identities;
}
