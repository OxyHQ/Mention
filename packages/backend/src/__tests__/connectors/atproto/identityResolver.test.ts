import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * atproto DID documents: DID → DID document (PLC directory / did:web `did.json`)
 * and the PDS it names. The SSRF-safe transport is mocked; these tests assert
 * the exact URLs each DID method resolves at.
 */

const mocks = vi.hoisted(() => ({
  safeGetJson: vi.fn(),
}));

vi.mock('../../../connectors/atproto/xrpcClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../connectors/atproto/xrpcClient')>();
  return { ...actual, safeGetJson: mocks.safeGetJson };
});

import {
  pdsEndpointFromDidDocument,
  resolveDidDocument,
} from '../../../connectors/atproto/identityResolver';

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveDidDocument', () => {
  it('resolves a did:plc document from the PLC directory', async () => {
    mocks.safeGetJson.mockResolvedValue({ id: DID });

    const doc = await resolveDidDocument(DID);

    expect(doc).toEqual({ id: DID });
    expect(mocks.safeGetJson).toHaveBeenCalledWith(`https://plc.directory/${DID}`);
  });

  it('resolves a did:web document from the well-known location', async () => {
    mocks.safeGetJson.mockResolvedValue({ id: 'did:web:example.com' });

    await resolveDidDocument('did:web:example.com');

    expect(mocks.safeGetJson).toHaveBeenCalledWith('https://example.com/.well-known/did.json');
  });

  it('resolves a path-scoped did:web document', async () => {
    mocks.safeGetJson.mockResolvedValue({ id: 'did:web:example.com:user:alice' });

    await resolveDidDocument('did:web:example.com:user:alice');

    expect(mocks.safeGetJson).toHaveBeenCalledWith('https://example.com/user/alice/did.json');
  });

  it('returns null for an unsupported DID method', async () => {
    const doc = await resolveDidDocument('did:key:zabc');
    expect(doc).toBeNull();
    expect(mocks.safeGetJson).not.toHaveBeenCalled();
  });
});

describe('DID document field extraction', () => {
  it('reads the PDS service endpoint', () => {
    const doc = {
      id: DID,
      alsoKnownAs: ['at://alice.bsky.social'],
      service: [
        {
          id: '#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: 'https://pds.example',
        },
      ],
    };
    expect(pdsEndpointFromDidDocument(doc)).toBe('https://pds.example');
  });
});
