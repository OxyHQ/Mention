import { resolveTxt } from 'node:dns/promises';
import { logger } from '../../utils/logger';
import { safeGetJson, safeGetText, xrpcGet, XrpcError } from './xrpcClient';
import { ANY_DID_RE, DID_PLC_RE, PLC_DIRECTORY, PUBLIC_APPVIEW } from './constants';

/**
 * AT Protocol identity resolution (handle ↔ DID ↔ DID document).
 *
 * atproto identities are anchored by a DID (`did:plc:` or `did:web:`); the
 * human-facing handle is a mutable DNS name that points BACK at the DID. This
 * module turns either form into the other and reads the DID document (which
 * lists the verified handle and the user's PDS service endpoint, needed later by
 * the C4 outbound bridge). Every network read goes through the SSRF-safe XRPC
 * client.
 */

/** The subset of an atproto DID document this connector reads. */
export interface AtprotoDidDocument {
  id?: string;
  alsoKnownAs?: string[];
  service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
  verificationMethod?: Array<{ id?: string; type?: string; publicKeyMultibase?: string }>;
}

/** A fully resolved atproto identity. */
export interface ResolvedAtprotoIdentity {
  /** The stable DID (`did:plc:...` / `did:web:...`). */
  did: string;
  /** The verified handle (from the DID doc / input), or the DID when unknown. */
  handle: string;
  /** The user's Personal Data Server endpoint, when the DID doc advertises one. */
  pdsEndpoint?: string;
}

/**
 * Resolve a handle to its DID.
 *
 * Primary: the AppView `com.atproto.identity.resolveHandle` query. Fallbacks
 * (handle's own domain authority): `https://<handle>/.well-known/atproto-did`
 * and the `_atproto.<handle>` DNS TXT record. Returns null when no method yields
 * a DID.
 */
export async function resolveHandleToDid(handle: string): Promise<string | null> {
  // 1. AppView resolveHandle (the common path).
  try {
    const res = await xrpcGet<{ did?: string }>(PUBLIC_APPVIEW, 'com.atproto.identity.resolveHandle', { handle });
    if (res?.did && ANY_DID_RE.test(res.did)) return res.did;
  } catch (err) {
    logger.debug(`[atproto] resolveHandle AppView failed for ${handle}`, err);
  }

  // 2. HTTPS well-known on the handle's own domain (SSRF-safe).
  try {
    const did = await safeGetText(`https://${handle}/.well-known/atproto-did`);
    if (ANY_DID_RE.test(did)) return did;
  } catch (err) {
    logger.debug(`[atproto] .well-known/atproto-did failed for ${handle}`, err);
  }

  // 3. DNS TXT `_atproto.<handle>` — value is `did=<did>`.
  try {
    const records = await resolveTxt(`_atproto.${handle}`);
    for (const chunks of records) {
      const value = chunks.join('').trim();
      const match = value.match(/^did=(.+)$/);
      if (match && ANY_DID_RE.test(match[1])) return match[1];
    }
  } catch (err) {
    logger.debug(`[atproto] _atproto DNS TXT failed for ${handle}`, err);
  }

  return null;
}

/** Convert a `did:web:` identifier to the `did.json` URL it resolves at. */
function didWebToDocumentUrl(did: string): string | null {
  const methodId = did.slice('did:web:'.length);
  if (!methodId) return null;
  const parts = methodId.split(':').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  const host = parts[0];
  if (!host) return null;
  // No path segments → the well-known location; otherwise a path-scoped doc.
  const path = parts.length > 1 ? `/${parts.slice(1).join('/')}/did.json` : '/.well-known/did.json';
  return `https://${host}${path}`;
}

/**
 * Fetch the DID document for a `did:plc:` (via the PLC directory) or `did:web:`
 * (via its `did.json`). Returns null for unsupported methods or on failure.
 */
export async function resolveDidDocument(did: string): Promise<AtprotoDidDocument | null> {
  try {
    if (DID_PLC_RE.test(did)) {
      return await safeGetJson<AtprotoDidDocument>(`https://${PLC_DIRECTORY}/${did}`);
    }
    if (did.startsWith('did:web:')) {
      const url = didWebToDocumentUrl(did);
      if (!url) return null;
      return await safeGetJson<AtprotoDidDocument>(url);
    }
  } catch (err) {
    if (err instanceof XrpcError) {
      logger.debug(`[atproto] DID document resolution failed for ${did}: ${err.message}`);
    } else {
      logger.debug(`[atproto] DID document resolution error for ${did}`, err);
    }
  }
  return null;
}

/** Extract the verified handle from a DID document's `alsoKnownAs` (`at://<handle>`). */
export function handleFromDidDocument(doc: AtprotoDidDocument): string | undefined {
  const aka = doc.alsoKnownAs?.find((value) => value.startsWith('at://'));
  return aka ? aka.slice('at://'.length) : undefined;
}

/** Extract the PDS service endpoint (`#atproto_pds`) from a DID document. */
export function pdsEndpointFromDidDocument(doc: AtprotoDidDocument): string | undefined {
  const service = doc.service?.find(
    (entry) => entry.id === '#atproto_pds' || entry.type === 'AtprotoPersonalDataServer',
  );
  return service?.serviceEndpoint;
}

/**
 * Resolve a handle OR a DID into a full {@link ResolvedAtprotoIdentity}.
 *
 * Determines the DID (the input when already a DID, else handle→DID), then
 * best-effort resolves the DID document to recover the verified handle and PDS
 * endpoint. DID-document failure is non-fatal: discovery still succeeds with the
 * DID and the input/derived handle.
 */
export async function resolveIdentity(handleOrDid: string): Promise<ResolvedAtprotoIdentity | null> {
  const isDidInput = ANY_DID_RE.test(handleOrDid);
  const did = isDidInput ? handleOrDid : await resolveHandleToDid(handleOrDid);
  if (!did) return null;

  const doc = await resolveDidDocument(did);
  const handle = (doc && handleFromDidDocument(doc)) || (isDidInput ? did : handleOrDid);
  const pdsEndpoint = doc ? pdsEndpointFromDidDocument(doc) : undefined;
  return { did, handle, pdsEndpoint };
}
