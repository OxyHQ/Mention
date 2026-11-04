import {
  lookupExternalIdentitiesResponseSchema,
  resolveExternalIdentityResponseSchema,
  type ExternalIdentityProtocol,
  type ResolveExternalIdentityResponse,
} from '@oxy.so/contracts';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { oxyErrorDetails, oxyErrorStatus } from '../services/oxyFiles/oxyErrors';

type ResolveInput =
  | { handle: string }
  | { actorUri: string; transportAcct?: string; protocol: ExternalIdentityProtocol };

/** Oxy's resolve answer, checked against the contract and its own canonical user. */
async function requestOxyResolve(input: ResolveInput): Promise<ResolveExternalIdentityResponse> {
  const response = await getServiceOxyClient().serviceRequest<unknown>(
    'POST',
    '/federation/identities/resolve',
    input,
  );
  const resolved = resolveExternalIdentityResponseSchema.parse(response);
  if (resolved.externalIdentity.userId !== resolved.user.id) {
    throw new Error('Oxy returned an inconsistent external identity');
  }
  return resolved;
}

/** Oxy verifies the source actor and owns its public identity and profile. */
export async function resolveOxyIdentity(
  input: ResolveInput,
): Promise<ResolveExternalIdentityResponse> {
  const resolved = await requestOxyResolve(input);
  if ('actorUri' in input && resolved.externalIdentity.actorUri !== input.actorUri) {
    throw new Error('Oxy returned an inconsistent external identity');
  }
  return resolved;
}

/** An Oxy answer that carries the source document Oxy fetched for it. */
export type ObservedOxySource = ResolveExternalIdentityResponse & {
  sourceDocument: Record<string, unknown>;
};

/**
 * One fresh read of a source actor, through Oxy: Oxy fetches the actor (a
 * signed, DNS-pinned GET, or `getProfile` for a DID), verifies it, and answers
 * with the identity AND the document it read. This is the only fetch of that
 * actor a Mention profile sync makes — Mention reads banner, counts, profile
 * fields, flags, inbox and keys from `sourceDocument` rather than asking the
 * source a second time. Oxy fetching independently is the security property
 * (it never trusts a document a caller hands it); Mention fetching too was the
 * duplicate.
 *
 * `status` is the source's own answer when Oxy could not verify it (410: the
 * actor is gone), 404 when Oxy refused it for any other reason. The resolved
 * source may differ from `actorUri` after a redirect; it is bound to the
 * document Oxy read (`sourceDocument` names it), and callers apply their own
 * origin rules to it.
 */
export async function observeOxySource(input: {
  actorUri: string;
  transportAcct?: string;
  protocol: ExternalIdentityProtocol;
}): Promise<{ status: number; resolved?: ObservedOxySource }> {
  let resolved: ResolveExternalIdentityResponse;
  try {
    resolved = await requestOxyResolve(input);
  } catch (error) {
    if (oxyErrorStatus(error) !== 404) throw error;
    const sourceStatus = oxyErrorDetails(error)?.sourceStatus;
    return { status: typeof sourceStatus === 'number' ? sourceStatus : 404 };
  }
  const { sourceDocument } = resolved;
  if (!sourceDocument) throw new Error('Oxy answered an actor resolve without the source document');
  return { status: 200, resolved: { ...resolved, sourceDocument } };
}

/** Read current Oxy proof without causing source discovery or minting identities. */
export async function lookupOxyIdentities(identifiers: string[]) {
  const response = await getServiceOxyClient().serviceRequest<unknown>(
    'POST',
    '/federation/identities/lookup',
    { identifiers },
  );
  return lookupExternalIdentitiesResponseSchema.parse(response).identities;
}
