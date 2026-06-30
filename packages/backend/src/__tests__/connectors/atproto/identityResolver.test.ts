import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * atproto identity resolution: handle → DID (AppView, then well-known / DNS
 * fallbacks) and DID → DID document (PLC directory / did:web `did.json`).
 * The SSRF-safe transport is mocked; these tests assert the resolution logic +
 * the exact URLs each DID method resolves at.
 */

const mocks = vi.hoisted(() => ({
  xrpcGet: vi.fn(),
  safeGetJson: vi.fn(),
  safeGetText: vi.fn(),
  resolveTxt: vi.fn(),
}));

vi.mock('../../../connectors/atproto/xrpcClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../connectors/atproto/xrpcClient')>();
  return {
    ...actual,
    xrpcGet: mocks.xrpcGet,
    safeGetJson: mocks.safeGetJson,
    safeGetText: mocks.safeGetText,
  };
});

vi.mock('node:dns/promises', () => ({ resolveTxt: mocks.resolveTxt }));

import {
  handleFromDidDocument,
  pdsEndpointFromDidDocument,
  resolveDidDocument,
  resolveHandleToDid,
  resolveIdentity,
} from '../../../connectors/atproto/identityResolver';

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTxt.mockRejectedValue(new Error('no txt'));
  mocks.safeGetText.mockRejectedValue(new Error('no well-known'));
});

describe('resolveHandleToDid', () => {
  it('resolves a handle via the AppView resolveHandle query', async () => {
    mocks.xrpcGet.mockResolvedValue({ did: DID });

    const did = await resolveHandleToDid('alice.bsky.social');

    expect(did).toBe(DID);
    expect(mocks.xrpcGet).toHaveBeenCalledWith(
      'public.api.bsky.app',
      'com.atproto.identity.resolveHandle',
      { handle: 'alice.bsky.social' },
    );
  });

  it('falls back to the .well-known/atproto-did document', async () => {
    mocks.xrpcGet.mockRejectedValue(new Error('appview down'));
    mocks.safeGetText.mockResolvedValue(DID);

    const did = await resolveHandleToDid('custom.example');

    expect(did).toBe(DID);
    expect(mocks.safeGetText).toHaveBeenCalledWith('https://custom.example/.well-known/atproto-did');
  });

  it('falls back to the _atproto DNS TXT record', async () => {
    mocks.xrpcGet.mockRejectedValue(new Error('appview down'));
    mocks.resolveTxt.mockResolvedValue([[`did=${DID}`]]);

    const did = await resolveHandleToDid('dns.example');

    expect(did).toBe(DID);
    expect(mocks.resolveTxt).toHaveBeenCalledWith('_atproto.dns.example');
  });

  it('returns null when no method yields a DID', async () => {
    mocks.xrpcGet.mockResolvedValue({});
    const did = await resolveHandleToDid('ghost.example');
    expect(did).toBeNull();
  });
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
  it('reads the handle from alsoKnownAs and the PDS service endpoint', () => {
    const doc = {
      id: DID,
      alsoKnownAs: ['at://alice.bsky.social'],
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }],
    };
    expect(handleFromDidDocument(doc)).toBe('alice.bsky.social');
    expect(pdsEndpointFromDidDocument(doc)).toBe('https://pds.example');
  });
});

describe('resolveIdentity', () => {
  it('resolves a handle to a full identity (DID + verified handle + PDS)', async () => {
    mocks.xrpcGet.mockResolvedValue({ did: DID });
    mocks.safeGetJson.mockResolvedValue({
      id: DID,
      alsoKnownAs: ['at://alice.bsky.social'],
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }],
    });

    const identity = await resolveIdentity('alice.bsky.social');

    expect(identity).toEqual({ did: DID, handle: 'alice.bsky.social', pdsEndpoint: 'https://pds.example' });
  });

  it('resolves a DID input without re-resolving the handle', async () => {
    mocks.safeGetJson.mockResolvedValue({ id: DID, alsoKnownAs: ['at://alice.bsky.social'] });

    const identity = await resolveIdentity(DID);

    expect(mocks.xrpcGet).not.toHaveBeenCalled();
    expect(identity).toMatchObject({ did: DID, handle: 'alice.bsky.social' });
  });
});
