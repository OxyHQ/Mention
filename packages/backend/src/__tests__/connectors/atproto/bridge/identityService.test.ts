import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DidDocument } from '@oxyhq/contracts';
import { buildUserDid } from '../../../../services/mtn/mentionDid';

/**
 * Phase C4 — bridge IDENTITY service. Resolves a local handle → the user's Oxy
 * `did:web` + bridge PDS endpoint, and builds the atproto-flavoured DID-document
 * VIEW (the canonical Oxy DID doc augmented with the `#atproto_pds` service). The
 * Oxy resolver + service client are MOCKED — no network.
 */

const mockResolveOxyUser = vi.fn();
const mockResolveDid = vi.fn();
const mockGetUserById = vi.fn();

vi.mock('../../../../connectors/activitypub/constants', async () => {
  const actual = await vi.importActual<typeof import('../../../../connectors/activitypub/constants')>(
    '../../../../connectors/activitypub/constants',
  );
  return { ...actual, resolveOxyUser: (...a: unknown[]) => mockResolveOxyUser(...a) };
});

vi.mock('../../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    resolveDid: (...a: unknown[]) => mockResolveDid(...a),
    getUserById: (...a: unknown[]) => mockGetUserById(...a),
  }),
}));

import {
  getAtprotoIdentity,
  getAtprotoIdentityByOxyUserId,
  buildBridgeDidDocumentView,
  bridgeHandle,
  bridgePdsEndpoint,
  ATPROTO_PDS_SERVICE_ID,
  ATPROTO_PDS_SERVICE_TYPE,
} from '../../../../connectors/atproto/bridge/identityService';

const OWNER = '650000000000000000000abc';

/** A canonical Oxy DID document with no atproto PDS entry. */
function canonicalDoc(): DidDocument {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: buildUserDid(OWNER),
    controller: [buildUserDid(OWNER), 'did:web:oxy.so'],
    verificationMethod: [
      {
        id: `${buildUserDid(OWNER)}#key-1`,
        type: 'EcdsaSecp256k1VerificationKey2019',
        controller: buildUserDid(OWNER),
        publicKeyHex: '04abcd',
      },
    ],
    authentication: [`${buildUserDid(OWNER)}#key-1`],
    assertionMethod: [`${buildUserDid(OWNER)}#key-1`],
    alsoKnownAs: ['acct:alice@oxy.so'],
    service: [{ id: '#oxy_api', type: 'OxyApi', serviceEndpoint: 'https://api.oxy.so' }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveOxyUser.mockResolvedValue({ id: OWNER, username: 'alice' });
  mockResolveDid.mockResolvedValue(canonicalDoc());
  mockGetUserById.mockResolvedValue({ id: OWNER, username: 'alice' });
});

describe('bridge handle / pds endpoint', () => {
  it('builds the bridge handle under the federation domain', () => {
    // Default FEDERATION_DOMAIN is mention.earth in the test env.
    expect(bridgeHandle('alice')).toMatch(/^alice\./);
  });

  it('builds an https PDS endpoint', () => {
    expect(bridgePdsEndpoint()).toMatch(/^https:\/\//);
  });
});

describe('getAtprotoIdentity', () => {
  it('resolves a local username to its Oxy DID + handle + PDS endpoint', async () => {
    const identity = await getAtprotoIdentity('alice');
    expect(identity).toMatchObject({
      did: buildUserDid(OWNER),
      oxyUserId: OWNER,
      handle: bridgeHandle('alice'),
      pdsEndpoint: bridgePdsEndpoint(),
    });
  });

  it('returns null for an unknown username', async () => {
    mockResolveOxyUser.mockResolvedValueOnce(null);
    expect(await getAtprotoIdentity('ghost')).toBeNull();
  });
});

describe('getAtprotoIdentityByOxyUserId', () => {
  it('derives the handle from the user\'s CURRENT username (never the raw id)', async () => {
    const identity = await getAtprotoIdentityByOxyUserId(OWNER);
    expect(identity).toMatchObject({
      did: buildUserDid(OWNER),
      oxyUserId: OWNER,
      handle: bridgeHandle('alice'),
      pdsEndpoint: bridgePdsEndpoint(),
    });
    expect(mockGetUserById).toHaveBeenCalledWith(OWNER);
    // The by-id path resolves the username from Oxy, not from the by-handle path.
    expect(mockResolveOxyUser).not.toHaveBeenCalled();
  });

  it('returns null when the id resolves to no Oxy user', async () => {
    mockGetUserById.mockRejectedValueOnce(new Error('not found'));
    expect(await getAtprotoIdentityByOxyUserId(OWNER)).toBeNull();
  });

  it('returns null when the resolved user carries no username', async () => {
    mockGetUserById.mockResolvedValueOnce({ id: OWNER });
    expect(await getAtprotoIdentityByOxyUserId(OWNER)).toBeNull();
  });
});

describe('buildBridgeDidDocumentView', () => {
  it('augments the canonical Oxy DID doc with the #atproto_pds service + at:// aka', async () => {
    const doc = await buildBridgeDidDocumentView('alice');
    expect(doc).not.toBeNull();
    const pds = doc?.service.find((s) => s.id === ATPROTO_PDS_SERVICE_ID);
    expect(pds).toMatchObject({
      id: ATPROTO_PDS_SERVICE_ID,
      type: ATPROTO_PDS_SERVICE_TYPE,
      serviceEndpoint: bridgePdsEndpoint(),
    });
    // The original Oxy service entry is preserved (augment, not replace).
    expect(doc?.service.some((s) => s.id === '#oxy_api')).toBe(true);
    expect(doc?.alsoKnownAs).toContain(`at://${bridgeHandle('alice')}`);
    // The canonical id is untouched.
    expect(doc?.id).toBe(buildUserDid(OWNER));
  });

  it('does NOT duplicate the #atproto_pds entry when the doc already has one', async () => {
    const doc = canonicalDoc();
    doc.service.push({ id: ATPROTO_PDS_SERVICE_ID, type: ATPROTO_PDS_SERVICE_TYPE, serviceEndpoint: 'https://x' });
    mockResolveDid.mockResolvedValueOnce(doc);
    const view = await buildBridgeDidDocumentView('alice');
    const pdsEntries = view?.service.filter((s) => s.id === ATPROTO_PDS_SERVICE_ID) ?? [];
    expect(pdsEntries).toHaveLength(1);
  });

  it('handles a sparse DID doc that omits alsoKnownAs / service (no crash)', async () => {
    // `alsoKnownAs` and `service` are OPTIONAL in a W3C DID document; a resolver
    // may return a doc that omits them. The view must default both to empty and
    // still attach the bridge handle + #atproto_pds entry.
    const sparse = canonicalDoc();
    delete (sparse as Partial<DidDocument>).alsoKnownAs;
    delete (sparse as Partial<DidDocument>).service;
    mockResolveDid.mockResolvedValueOnce(sparse);

    const view = await buildBridgeDidDocumentView('alice');
    expect(view).not.toBeNull();
    expect(view?.alsoKnownAs).toEqual([`at://${bridgeHandle('alice')}`]);
    expect(view?.service).toEqual([
      {
        id: ATPROTO_PDS_SERVICE_ID,
        type: ATPROTO_PDS_SERVICE_TYPE,
        serviceEndpoint: bridgePdsEndpoint(),
      },
    ]);
  });

  it('returns null when the canonical Oxy DID document cannot be resolved', async () => {
    mockResolveDid.mockRejectedValueOnce(new Error('upstream down'));
    expect(await buildBridgeDidDocumentView('alice')).toBeNull();
  });

  it('returns null for an unknown user', async () => {
    mockResolveOxyUser.mockResolvedValueOnce(null);
    expect(await buildBridgeDidDocumentView('ghost')).toBeNull();
  });
});
