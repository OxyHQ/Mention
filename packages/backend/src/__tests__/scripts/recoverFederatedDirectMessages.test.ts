import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostVisibility } from '@mention/shared-types';

/**
 * The private-mention recovery over real rows: a federated direct message that
 * the first repair hid as `private` becomes a `direct` post for the local user
 * it was sent to; a dry run changes nothing; a second run finds nothing left to
 * convert. Only the origin fetch and Oxy's username lookup are faked.
 */

const REMOTE_AUTHOR = 'https://remote.test/users/carol';
const LOCAL_ACTOR = 'https://mention.earth/ap/users/alice';
const ALICE = 'oxy-recover-dm-alice';
const notes = new Map<string, Record<string, unknown>>();

vi.mock('../../connectors/activitypub/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/activitypub/helpers')>()),
  fetchActivityPubObject: async (uri: string) => notes.get(uri) ?? null,
}));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    users: {
      byUsername: async (username: string) => (username === 'alice' ? { id: ALICE } : null),
    },
  }),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { loadPostRecord } from '../../db/posts/postRepository';
import { recoverFederatedDirectMessages } from '../../scripts/recoverFederatedDirectMessages';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

const scope = postScope('recover-dm');

function federatedPost(noteId: string, visibility: PostVisibility, to: string[]) {
  notes.set(noteId, { id: noteId, type: 'Note', attributedTo: REMOTE_AUTHOR, to, cc: [] });
  return seedPost(scope, {
    visibility,
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
});
