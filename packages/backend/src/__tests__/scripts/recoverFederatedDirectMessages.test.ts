import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostVisibility } from '@mention/shared-types';

/**
 * The private-mention recovery over real rows: a federated direct message that
 * the first repair hid as `private` becomes a `direct` post for the local user
 * it was sent to; a dry run changes nothing; a second run finds nothing left to
 * convert. A note the origin refuses to the instance is fetched signed as the
 * local user it addresses; an origin failure leaves the post for a re-run. Only
 * the origin fetch and Oxy's user and key lookups are faked.
 */

const REMOTE_AUTHOR = 'https://remote.test/users/carol';
const LOCAL_ACTOR = 'https://mention.earth/ap/users/alice';
const ALICE = 'oxy-recover-dm-alice';
const ALICE_KEY = `${LOCAL_ACTOR}#main-key`;
const notes = new Map<string, Record<string, unknown>>();
/** Notes the origin serves only to these signers (`undefined` = the instance), else this status. */
const gated = new Map<string, { readers: Array<string | undefined>; status: number }>();

vi.mock('../../connectors/activitypub/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/activitypub/helpers')>()),
  fetchActivityPubObjectAs: async (uri: string, options: { keyId?: string } = {}) => {
    const gate = gated.get(uri);
    if (gate && !gate.readers.includes(options.keyId)) {
      if (gate.status >= 500) return { kind: 'failed', status: gate.status };
      return { kind: gate.status === 404 ? 'notFound' : 'refused', status: gate.status };
    }
    const object = notes.get(uri);
    return object ? { kind: 'object', object } : { kind: 'notFound', status: 404 };
  },
}));
vi.mock('../../connectors/activitypub/crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/activitypub/crypto')>()),
  getPublicKey: async (username: string) => ({
    keyId: `https://mention.earth/ap/users/${username}#main-key`,
    publicKeyPem: 'pem',
  }),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    users: {
      byUsername: async (username: string) => (username === 'alice' ? { id: ALICE } : null),
      getMany: async (ids: string[]) =>
        ids.includes(ALICE) ? [{ id: ALICE, username: 'alice', type: 'local' }] : [],
    },
  }),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { loadPostRecord } from '../../db/posts/postRepository';
import {
  addressingShape,
  recoverFederatedDirectMessages,
} from '../../scripts/recoverFederatedDirectMessages';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

const scope = postScope('recover-dm');

function federatedPost(
  noteId: string,
  visibility: PostVisibility,
  to: string[],
  mentions: string[] = [],
) {
  notes.set(noteId, { id: noteId, type: 'Note', attributedTo: REMOTE_AUTHOR, to, cc: [] });
  return seedPost(scope, {
    visibility,
    mentions,
    federation: { activityId: noteId, actorUri: REMOTE_AUTHOR },
  });
}

describe('recoverFederatedDirectMessages', () => {
  beforeAll(async () => {
    await connectPostgres();
  });
  afterAll(async () => {
    await clearPostScope(scope);
    await closePostgres();
  });

  it('turns a hidden direct message into a private mention for its local recipient', async () => {
    const hidden = await federatedPost('https://remote.test/notes/dm', PostVisibility.PRIVATE, [
      LOCAL_ACTOR,
    ]);
    const dry = await recoverFederatedDirectMessages({ dryRun: true });
    expect(dry.converted).toBe(1);
    expect((await loadPostRecord(hidden.id))?.visibility).toBe(PostVisibility.PRIVATE);

    await recoverFederatedDirectMessages({ dryRun: false });
    const recovered = await loadPostRecord(hidden.id);
    expect(recovered?.visibility).toBe(PostVisibility.DIRECT);
    expect(recovered?.recipients).toEqual([ALICE]);

    // Idempotent: nothing is left to convert.
    expect((await recoverFederatedDirectMessages({ dryRun: false })).converted).toBe(0);
  });

  it('fetches a note the instance is refused signed as the local user it addresses', async () => {
    const noteId = 'https://remote.test/notes/dm-authorized';
    gated.set(noteId, { readers: [ALICE_KEY], status: 401 });
    const dm = await federatedPost(noteId, PostVisibility.FOLLOWERS_ONLY, [LOCAL_ACTOR], [ALICE]);

    const run = await recoverFederatedDirectMessages({ dryRun: false });
    expect(run).toMatchObject({ converted: 1, fetchedAsActor: 1, hidden: 0 });
    const recovered = await loadPostRecord(dm.id);
    expect(recovered?.visibility).toBe(PostVisibility.DIRECT);
    expect(recovered?.recipients).toEqual([ALICE]);
  });

  it('describes the addressing of a note by class, without its URLs', () => {
    const note = { type: 'Note', attributedTo: REMOTE_AUTHOR, to: 'as:Public', cc: [LOCAL_ACTOR] };
    expect(addressingShape(note, REMOTE_AUTHOR, undefined)).toBe(
      'Note to=single[public-compact] cc=array[local-actor] followersUrl=missing attributedTo=actor',
    );
  });

  it('restores a post the old rule misread as non-public', async () => {
    const post = await federatedPost(
      'https://remote.test/notes/compact-public',
      PostVisibility.FOLLOWERS_ONLY,
      ['as:Public'],
    );

    const run = await recoverFederatedDirectMessages({ dryRun: false });
    expect(run).toMatchObject({ restoredPublic: 1, hidden: 0 });
    expect((await loadPostRecord(post.id))?.visibility).toBe(PostVisibility.PUBLIC);
  });

  it('leaves a post whose origin fails unchanged for a re-run', async () => {
    const noteId = 'https://remote.test/notes/origin-down';
    gated.set(noteId, { readers: [], status: 503 });
    const post = await federatedPost(noteId, PostVisibility.FOLLOWERS_ONLY, [LOCAL_ACTOR], [ALICE]);

    const run = await recoverFederatedDirectMessages({ dryRun: false });
    expect(run).toMatchObject({ retryLater: 1, hidden: 0, converted: 0 });
    expect((await loadPostRecord(post.id))?.visibility).toBe(PostVisibility.FOLLOWERS_ONLY);
  });
});
