/**
 * Atproto bridge IDENTITY service (Phase C4).
 *
 * Makes a local Mention user atproto-RESOLVABLE so a Bluesky AppView can discover
 * the user and find the bridge PDS that hosts their content.
 *
 * ## did:web — and the oxy-api SEAM (FLAGGED)
 *
 * A Mention user's canonical DID is their Oxy `did:web` (`did:web:oxy.so:u:<id>`,
 * served by oxy-api and derived on demand from the account's auth methods +
 * public key). atproto natively accepts `did:web`, so NO new keypair scheme is
 * needed. BUT the canonical Oxy `did.json` (owned by oxy-api) does NOT advertise
 * an `#atproto_pds` service entry or an atproto-format verification method, and
 * Mention CANNOT add one to a document hosted at `oxy.so`.
 *
 * For a foreign AppView to route to Mention's bridge as the user's PDS, the Oxy
 * DID document MUST gain an `#atproto_pds` service whose endpoint points at this
 * bridge (and, for strict atproto, a `Multikey`/`publicKeyMultibase` verification
 * method alongside the existing `EcdsaSecp256k1VerificationKey2019` ones). That is
 * an oxy-api DID-composition change — FLAGGED as an upstream dependency. It is
 * NOT hacked here with a parallel/competing DID document.
 *
 * What the bridge DOES serve, honestly, today:
 *  - `getAtprotoIdentity(username)` — resolve a local handle → the user's Oxy DID +
 *    the bridge handle + the PDS endpoint the bridge WOULD advertise. This is the
 *    data a `.well-known/atproto-did` / handle-resolution response needs.
 *  - an atproto-flavoured DID-document VIEW (`buildBridgeDidDocumentView`) that
 *    augments the canonical Oxy DID document with the `#atproto_pds` service —
 *    served at the bridge so tooling that fetches the bridge's identity view sees
 *    the PDS wiring. It NEVER claims to BE the canonical `did:web` `did.json`.
 */

import type { DidDocument } from '@oxyhq/contracts';
import { getServiceOxyClient } from '../../../utils/oxyHelpers';
import { logger } from '../../../utils/logger';
import { resolveOxyUser } from '../../activitypub/constants';
import { buildUserDid } from '../../../services/mtn/mentionDid';
import { BRIDGE_DOMAIN } from './constants';

/** The fragment id of the atproto PDS service entry the bridge advertises. */
export const ATPROTO_PDS_SERVICE_ID = '#atproto_pds';
/** The atproto service type for a Personal Data Server. */
export const ATPROTO_PDS_SERVICE_TYPE = 'AtprotoPersonalDataServer';

/** The bridge's atproto identity facts for a local user. */
export interface BridgeAtprotoIdentity {
  /** The user's canonical Oxy DID (`did:web:oxy.so:u:<oxyUserId>`). */
  did: string;
  /** The user's Oxy account id (string). */
  oxyUserId: string;
  /** The bridge handle (`<username>.<bridge domain>`), the atproto-style handle. */
  handle: string;
  /** The PDS service endpoint the bridge hosts the user's repo at. */
  pdsEndpoint: string;
}

/** The HTTPS base URL of the bridge PDS the user's repo is served from. */
export function bridgePdsEndpoint(): string {
  return `https://${BRIDGE_DOMAIN}`;
}

/**
 * The atproto-style handle for a local user under the bridge domain
 * (`<username>.<bridge domain>`). This is the handle a `.well-known/atproto-did`
 * on `<username>.<bridge domain>` (or the bridge's handle-resolution endpoint)
 * resolves to the user's Oxy DID.
 */
export function bridgeHandle(username: string): string {
  return `${username}.${BRIDGE_DOMAIN}`;
}

/**
 * Assemble the bridge identity facts from an already-resolved `(oxyUserId,
 * username)` pair. The single builder both entry points funnel through so the
 * DID / handle / PDS shape can never drift between the by-handle and by-id paths.
 */
function buildIdentity(oxyUserId: string, username: string): BridgeAtprotoIdentity {
  return {
    did: buildUserDid(oxyUserId),
    oxyUserId,
    handle: bridgeHandle(username),
    pdsEndpoint: bridgePdsEndpoint(),
  };
}

/**
 * Resolve a local username to its atproto bridge identity (Oxy DID + bridge
 * handle + PDS endpoint). Returns null when the username is not a local Oxy user.
 */
export async function getAtprotoIdentity(username: string): Promise<BridgeAtprotoIdentity | null> {
  const user = await resolveOxyUser(username);
  const oxyUserId = user?.id ? String(user.id) : undefined;
  if (!oxyUserId) return null;
  return buildIdentity(oxyUserId, username);
}

/**
 * Resolve a known Oxy user id to its atproto bridge identity. This is the inverse
 * of {@link getAtprotoIdentity}: the caller already holds the canonical
 * `oxyUserId` (e.g. parsed from the repo's `did:web`) and needs the bridge handle,
 * which is derived from the user's CURRENT Oxy username — never re-parsed from the
 * raw DID/handle string. Returns null when the id maps to no Oxy user (or the
 * user record carries no username).
 */
export async function getAtprotoIdentityByOxyUserId(
  oxyUserId: string,
): Promise<BridgeAtprotoIdentity | null> {
  let username: string | undefined;
  try {
    const user = await getServiceOxyClient().getUserById(oxyUserId);
    username = user.username;
  } catch (err) {
    logger.warn('[atproto-bridge] failed to resolve Oxy user by id', {
      oxyUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!username) return null;
  return buildIdentity(oxyUserId, username);
}

/**
 * Build the atproto-flavoured DID-document VIEW for a local user: the canonical
 * Oxy DID document (fetched via the service client) augmented with the
 * `#atproto_pds` service entry pointing at the bridge, and the bridge handle
 * added to `alsoKnownAs` (`at://<handle>`).
 *
 * This is the document the BRIDGE serves for tooling that asks the bridge for the
 * user's atproto identity view; it is NOT a replacement for the canonical
 * `oxy.so` `did.json` (that augmentation is the FLAGGED oxy-api seam). Returns
 * null when the user or the canonical document cannot be resolved.
 */
export async function buildBridgeDidDocumentView(username: string): Promise<DidDocument | null> {
  const identity = await getAtprotoIdentity(username);
  if (!identity) return null;

  let canonical: DidDocument;
  try {
    canonical = await getServiceOxyClient().resolveDid(identity.oxyUserId);
  } catch (err) {
    logger.warn('[atproto-bridge] failed to resolve canonical Oxy DID document', {
      username,
      oxyUserId: identity.oxyUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // `alsoKnownAs` and `service` are OPTIONAL in a W3C DID document; a resolver
  // may return a document that omits either array. Default a missing array to
  // empty before augmenting so the bridge never crashes on a sparse DID doc.
  const existingAka = canonical.alsoKnownAs ?? [];
  const existingService = canonical.service ?? [];

  const akaHandle = `at://${identity.handle}`;
  const alsoKnownAs = existingAka.includes(akaHandle)
    ? [...existingAka]
    : [...existingAka, akaHandle];

  // Augment (do not replace) the service array with the atproto PDS entry.
  const hasPds = existingService.some((entry) => entry.id === ATPROTO_PDS_SERVICE_ID);
  const service = hasPds
    ? [...existingService]
    : [
        ...existingService,
        {
          id: ATPROTO_PDS_SERVICE_ID,
          type: ATPROTO_PDS_SERVICE_TYPE,
          serviceEndpoint: identity.pdsEndpoint,
        },
      ];

  return { ...canonical, alsoKnownAs, service };
}
