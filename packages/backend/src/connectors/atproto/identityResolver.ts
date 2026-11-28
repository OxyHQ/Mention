import { logger } from '../../utils/logger';
import { safeGetJson, XrpcError } from './xrpcClient';
import { DID_PLC_RE, PLC_DIRECTORY } from './constants';

/**
 * AT Protocol DID documents: where an account's PDS is, which is where a post's
 * video blob is fetched from. Every network read goes through the SSRF-safe XRPC
 * client.
 *
 * Handle ↔ DID resolution is not here: Oxy verifies an account's identity
 * (`/federation/identities/resolve`), and Mention reads the profile Oxy verified.
 */

/** The subset of an atproto DID document this connector reads. */
export interface AtprotoDidDocument {
  id?: string;
  alsoKnownAs?: string[];
  service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
  verificationMethod?: Array<{ id?: string; type?: string; publicKeyMultibase?: string }>;
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
      logger.debug('[atproto] DID document resolution failed', err);
    } else {
      logger.debug('[atproto] DID document resolution error', err);
    }
  }
  return null;
}

/** Extract the PDS service endpoint (`#atproto_pds`) from a DID document. */
export function pdsEndpointFromDidDocument(doc: AtprotoDidDocument): string | undefined {
  const service = doc.service?.find(
    (entry) => entry.id === '#atproto_pds' || entry.type === 'AtprotoPersonalDataServer',
  );
  return service?.serviceEndpoint;
}
