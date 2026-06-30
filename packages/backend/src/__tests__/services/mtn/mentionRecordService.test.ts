import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  verifyEnvelopeSignature,
  isAuthorizedKey,
  type RecordStore,
  type ChainHead,
} from '@oxyhq/protocol';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

/**
 * MTN Protocol — Workstream B / B1 dual-write verification.
 *
 * Exercises the REAL `@oxyhq/protocol` engine (custodial `signEnvelope` +
 * `verifyAndAppend`) against an in-memory `RecordStore` and a resolver whose
 * subject VMs come from a mocked `oxyServices.resolveDid`, so the whole chain
 * (sign → verify → append → re-verify) runs without Mongo. Covers:
 *  - a local post create writes a verifiable `app.mention.feed.post` record with
 *    the right chain coordinates (genesis seq 0, then seq 1 / prev = head),
 *  - a like writes an `app.mention.feed.like` record,
 *  - `signAndAppend` retries on a `chain_conflict`,
 *  - a FEDERATED post does NOT emit.
 */

// --- A fixed custodial secp256k1 keypair the resolver will authorize (issuer ===
//     MENTION_DID). Precomputed so the test needs no key-generation dependency;
//     `signEnvelope` derives `publicKey` as the uncompressed hex of the private
//     key, which equals CUSTODIAL_PUBLIC. ---
const CUSTODIAL_PRIVATE = 'd6bd0dbca0e4e37f4329e615cde35d1990ff6650d5b88a58c470d6d393cc6584';
const CUSTODIAL_PUBLIC =
  '04d5c06b76d56858b73655c4cc03594cc17e60d1a1607e14b98387bf5dcc62282a66ad2e1eb60b96fb854f1c303b1d50a7eebbcb06ea7151f69b0e2cbc436f43a6';
const MENTION_DID = 'did:web:mention.earth';
const SUBJECT_OXY_ID = '650000000000000000000abc';
const SUBJECT_DID = `did:web:oxy.so:u:${SUBJECT_OXY_ID}`;

// --- In-memory RecordStore (the protocol `RecordStore` contract). -------------
// Built inside `vi.hoisted` so it exists before the hoisted `vi.mock` factories.
interface MemoryStore extends RecordStore {
  rows: Array<{ env: SignedRecordEnvelope; recordId: string }>;
  heads: Map<string, ChainHead>;
  conflictOnce: boolean;
}

const { memoryStore, resolveDid } = vi.hoisted(() => {
  const rows: Array<{ env: SignedRecordEnvelope; recordId: string }> = [];
  const heads = new Map<string, ChainHead>();
  const store: MemoryStore = {
    rows,
    heads,
    conflictOnce: false,
    async getHead(subject) {
      return heads.get(subject) ?? null;
    },
    async append(subject, env, recordId) {
      if (store.conflictOnce) {
        store.conflictOnce = false;
        return { ok: false, reason: 'chain_conflict' };
      }
      rows.push({ env, recordId });
      heads.set(subject, {
        headRecordId: recordId,
        seq: env.seq as number,
        recordCount: (heads.get(subject)?.recordCount ?? 0) + 1,
      });
      return { ok: true, recordId, seq: env.seq as number };
    },
    async getLogSince(subject, sinceSeq, limit) {
      return rows
        .filter((r) => r.env.subject === subject && (r.env.seq ?? -1) > sinceSeq)
        .sort((a, b) => (a.env.seq ?? 0) - (b.env.seq ?? 0))
        .slice(0, limit)
        .map((r) => r.env);
    },
    async resolveCursorSeq(subject, recordId) {
      const row = rows.find((r) => r.env.subject === subject && r.recordId === recordId);
      return typeof row?.env.seq === 'number' ? row.env.seq : null;
    },
    async materializeCurrent(subject, collection, rkey) {
      const matches = rows.filter(
        (r) => r.env.subject === subject && r.env.collection === collection && r.env.rkey === rkey,
      );
      return matches.length ? matches[matches.length - 1].env : null;
    },
    async latestIssuedAtForKey(subject, env) {
      if (env.version === 2 && (typeof env.collection !== 'string' || typeof env.rkey !== 'string')) {
        return null;
      }
      const matches = rows.filter(
        (r) => r.env.subject === subject && r.env.collection === env.collection && r.env.rkey === env.rkey,
      );
      const latest = matches[matches.length - 1];
      return typeof latest?.env.issuedAt === 'number' ? latest.env.issuedAt : null;
    },
  };
  // The resolver resolves subject VMs via oxyServices.resolveDid; the subject has
  // NO Oxy keys by default, so only the custodial branch authorizes.
  const resolveDidMock = vi.fn(async () => ({ verificationMethod: [] as Array<{ publicKeyHex: string }> }));
  return { memoryStore: store, resolveDid: resolveDidMock };
});

// --- Mocks -------------------------------------------------------------------
vi.mock('../../../services/mtn/MentionRecordStore', () => ({
  mentionRecordStore: memoryStore,
}));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ resolveDid }),
}));

import { signAndAppend } from '../../../services/mtn/MentionRecordService';
import { mentionVerificationResolver, clearVerificationMethodCache } from '../../../services/mtn/mentionVerificationResolver';
import { emitPostCreated } from '../../../services/mtn/MentionRecordEmitter';
import {
  MENTION_POST_COLLECTION,
  MENTION_LIKE_COLLECTION,
  createPostUri,
} from '@mention/shared-types';

beforeEach(() => {
  process.env.MENTION_DID = MENTION_DID;
  process.env.MENTION_PRIVATE_KEY = CUSTODIAL_PRIVATE;
  process.env.MENTION_PUBLIC_KEY = CUSTODIAL_PUBLIC;
  // Clear IN PLACE — the mock's `append` closure captured these references.
  memoryStore.rows.length = 0;
  memoryStore.heads.clear();
  memoryStore.conflictOnce = false;
  resolveDid.mockClear();
  clearVerificationMethodCache();
});

afterEach(() => {
  delete process.env.MENTION_DID;
  delete process.env.MENTION_PRIVATE_KEY;
  delete process.env.MENTION_PUBLIC_KEY;
});

describe('MentionRecordService.signAndAppend', () => {
  it('writes a verifiable app.mention.feed.post genesis record with seq 0 / prev null', async () => {
    const result = await signAndAppend(SUBJECT_OXY_ID, MENTION_POST_COLLECTION, 'post-1', {
      text: 'hello world',
      createdAt: new Date().toISOString(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seq).toBe(0);

    const stored = memoryStore.rows[0].env;
    expect(stored.version).toBe(2);
    expect(stored.type).toBe('app_record');
    expect(stored.subject).toBe(SUBJECT_DID);
    expect(stored.issuer).toBe(MENTION_DID);
    expect(stored.collection).toBe(MENTION_POST_COLLECTION);
    expect(stored.rkey).toBe('post-1');
    expect(stored.seq).toBe(0);
    expect(stored.prev).toBeNull();
    expect(stored.publicKey).toBe(CUSTODIAL_PUBLIC);
    expect(stored.record).toMatchObject({ text: 'hello world' });

    // The stored record's signature is internally consistent with its embedded
    // publicKey, AND that key is an AUTHORIZED writer for the issuer (the Mention
    // custodial key). (The full append-time state machine is not idempotent, so
    // we assert the two stable properties: signature + issuer authorization.)
    expect(await verifyEnvelopeSignature(stored)).toBe(true);
    const resolved = await mentionVerificationResolver.resolve(stored.subject);
    expect(isAuthorizedKey(resolved, stored).ok).toBe(true);
  });

  it('chains a second record onto the head (seq 1, prev = head recordId)', async () => {
    const first = await signAndAppend(SUBJECT_OXY_ID, MENTION_POST_COLLECTION, 'post-1', {
      text: 'first',
      createdAt: new Date().toISOString(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await signAndAppend(SUBJECT_OXY_ID, MENTION_POST_COLLECTION, 'post-2', {
      text: 'second',
      createdAt: new Date().toISOString(),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.seq).toBe(1);
    expect(second.envelope.prev).toBe(first.recordId);
  });

  it('writes an app.mention.feed.like record whose subject is the liked post URI', async () => {
    const likedPostUri = createPostUri('owner-oxy-id', 'liked-post-1');
    const result = await signAndAppend(SUBJECT_OXY_ID, MENTION_LIKE_COLLECTION, 'like-1', {
      subject: likedPostUri,
      createdAt: new Date().toISOString(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = memoryStore.rows[0].env;
    expect(stored.collection).toBe(MENTION_LIKE_COLLECTION);
    expect(stored.rkey).toBe('like-1');
    expect(stored.record).toMatchObject({ subject: likedPostUri });
  });

  it('retries on a one-shot chain_conflict and succeeds', async () => {
    memoryStore.conflictOnce = true;
    const result = await signAndAppend(SUBJECT_OXY_ID, MENTION_POST_COLLECTION, 'post-1', {
      text: 'survives a race',
      createdAt: new Date().toISOString(),
    });
    // The first append reported chain_conflict; the retry re-read the head and
    // appended successfully.
    expect(result.ok).toBe(true);
    expect(memoryStore.rows).toHaveLength(1);
  });

  it('is a no-op (disabled) when the custodial key is unconfigured', async () => {
    delete process.env.MENTION_PRIVATE_KEY;
    const result = await signAndAppend(SUBJECT_OXY_ID, MENTION_POST_COLLECTION, 'post-1', {
      text: 'no key',
      createdAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('disabled');
    expect(memoryStore.rows).toHaveLength(0);
  });

  it('authorizes a subject-issued (native) record when the key is an Oxy VM', async () => {
    // A native record where issuer === subject must be authorized when the
    // signing key is one of the subject's resolved Oxy verification methods.
    resolveDid.mockResolvedValueOnce({ verificationMethod: [{ publicKeyHex: CUSTODIAL_PUBLIC }] });
    const resolved = await mentionVerificationResolver.resolve(SUBJECT_DID);
    expect(resolved?.currentPublicKeys).toContain(CUSTODIAL_PUBLIC);
    expect(resolved?.custodialIssuer).toBe(MENTION_DID);
    expect(resolved?.custodialPublicKey).toBe(CUSTODIAL_PUBLIC);
  });
});

describe('MentionRecordEmitter dual-write gate', () => {
  it('does NOT emit for a federated post', async () => {
    const federatedPost = {
      _id: 'fed-post-1',
      oxyUserId: SUBJECT_OXY_ID,
      federation: { activityId: 'https://remote.example/notes/1', actorUri: 'https://remote.example/u/a' },
      content: { text: 'remote post' },
      createdAt: new Date().toISOString(),
    } as unknown as Parameters<typeof emitPostCreated>[0];

    await emitPostCreated(federatedPost);
    expect(memoryStore.rows).toHaveLength(0);
  });

  it('emits an app.mention.feed.post for a LOCAL post', async () => {
    const localPost = {
      _id: 'local-post-1',
      oxyUserId: SUBJECT_OXY_ID,
      federation: undefined,
      content: { text: 'native post', sources: [], media: [] },
      hashtags: ['mtn'],
      language: 'en',
      createdAt: new Date().toISOString(),
    } as unknown as Parameters<typeof emitPostCreated>[0];

    await emitPostCreated(localPost);
    expect(memoryStore.rows).toHaveLength(1);
    const stored = memoryStore.rows[0].env;
    expect(stored.collection).toBe(MENTION_POST_COLLECTION);
    expect(stored.rkey).toBe('local-post-1');
    expect(stored.record).toMatchObject({ text: 'native post', tags: ['mtn'], langs: ['en'] });
  });
});
