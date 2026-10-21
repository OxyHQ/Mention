import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AP_CONTEXT } from '@oxy.so/federation';
import { FEDERATION_DOMAIN } from '../../connectors/activitypub/constants';
const mocks = vi.hoisted(() => ({
  mayFederate: vi.fn(),
  policies: vi.fn(),
  load: vi.fn(),
  decisions: vi.fn(),
  profile: vi.fn(),
}));
vi.mock('../../services/postPublicationPolicy', () => ({
  authorsMayFederate: mocks.mayFederate,
  authorPublicationPolicies: mocks.policies,
  postAuthorIds: (post: { oxyUserId: string; authorship?: { oxyUserId: string }[] }) => [
    ...new Set([post.oxyUserId, ...(post.authorship ?? []).map((author) => author.oxyUserId)]),
  ],
}));
vi.mock('../../db/posts/postRepository', () => ({ loadPostRecord: mocks.load }));
vi.mock('../../services/postSafetyAccess', () => ({ loadPostSafetyDecisions: mocks.decisions }));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ safety: { profileAccess: mocks.profile } }),
}));
import { authorizeFederationDelivery } from '../../services/federation/publicationPolicy';
const actor = `https://${FEDERATION_DOMAIN}/ap/users/alice`;
const note = `${actor}/posts/post-1`;
const policy = {
  publicationAllowed: true,
  requiredAudience: null,
  collaborationAllowed: true,
  federationAllowed: true,
  policyVersion: '2',
};
const post = {
  id: 'post-1',
  oxyUserId: 'alice-account',
  authorship: [{ oxyUserId: 'alice-account' }],
  status: 'published',
  visibility: 'public',
};
const create = () => ({
  '@context': AP_CONTEXT,
  id: `${note}/create`,
  type: 'Create',
  actor,
  object: { id: note, type: 'Note', content: 'Public text' },
});
const authorize = (activity: Record<string, unknown>) =>
  authorizeFederationDelivery({ activity, senderAccountId: 'alice-account' });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.mayFederate.mockResolvedValue(true);
  mocks.load.mockResolvedValue(post);
  mocks.policies.mockResolvedValue(new Map([['alice-account', policy]]));
  mocks.decisions.mockResolvedValue(
    new Map([['post-1', { allowed: true, reason: 'allowed', policyVersion: '2' }]]),
  );
  mocks.profile.mockResolvedValue({ allowed: true, reason: 'public', policyVersion: '2' });
});
describe('persisted-resource federation authorization', () => {
  it('permits a current public persisted post, then refuses revoked coauthor or private audience', async () => {
    expect(await authorize(create())).toBe(true);
    expect(
      await authorize({
        ...create(),
        object: { id: note, type: 'Question', oneOf: [{ type: 'Note', name: 'Yes' }] },
      }),
    ).toBe(true);
    mocks.policies.mockResolvedValue(
      new Map([
        ['alice-account', { ...policy, federationAllowed: false, requiredAudience: 'private' }],
      ]),
    );
    expect(await authorize(create())).toBe(false);
    mocks.policies.mockResolvedValue(new Map([['alice-account', policy]]));
    mocks.load.mockResolvedValue({ ...post, visibility: 'private' });
    expect(await authorize(create())).toBe(false);
  });
  it.each(['https://foreign.example/note/1', `https://${FEDERATION_DOMAIN}/unknown`])(
    'refuses unbound Create and Update Note resources: %s',
    async (id) => {
      for (const type of ['Create', 'Update'])
        expect(await authorize({ ...create(), type, object: { id, type: 'Note' } })).toBe(false);
      expect(mocks.load).not.toHaveBeenCalled();
    },
  );
  it('refuses missing rows and a trusted sender who is not a persisted author', async () => {
    mocks.load.mockResolvedValue(null);
    expect(await authorize(create())).toBe(false);
    mocks.load.mockResolvedValue({ ...post, oxyUserId: 'someone-else', authorship: [] });
    expect(await authorize(create())).toBe(false);
  });
  it('allows a known Follow and public actor Update, but propagates authority failures', async () => {
    expect(
      await authorize({
        '@context': AP_CONTEXT,
        id: `actor/follow/1`,
        type: 'Follow',
        actor,
        object: 'https://remote.example/bob',
      }),
    ).toBe(false);
    // The shared engine's `sendFollow` sends the bare AS2 context.
    expect(
      await authorize({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${actor}/follow/1`,
        type: 'Follow',
        actor,
        object: 'https://remote.example/bob',
      }),
    ).toBe(true);
    const update = {
      ...create(),
      type: 'Update',
      object: { id: actor, type: 'Person', name: 'Alice' },
    };
    expect(await authorize(update)).toBe(true);
    mocks.profile.mockResolvedValue({ allowed: false, reason: 'private', policyVersion: '2' });
    expect(await authorize(update)).toBe(false);
    mocks.mayFederate.mockRejectedValue(new Error('authority unavailable'));
    await expect(authorize(create())).rejects.toThrow('authority unavailable');
  });
  it('permits only narrow reference-only retractions after enrollment', async () => {
    mocks.mayFederate.mockResolvedValue(false);
    const deletion = {
      '@context': AP_CONTEXT,
      id: `${note}/delete`,
      type: 'Delete',
      actor,
      object: { id: note, type: 'Tombstone' },
    };
    expect(await authorize(deletion)).toBe(true);
    for (const field of ['content', 'summary', 'name', 'attachment']) {
      expect(await authorize({ ...deletion, [field]: 'private data' })).toBe(false);
      expect(
        await authorize({ ...deletion, object: { ...deletion.object, [field]: 'private data' } }),
      ).toBe(false);
    }
    const undo = {
      ...deletion,
      type: 'Undo',
      object: { id: `${actor}/likes/1`, type: 'Like', actor, object: note },
    };
    expect(await authorize(undo)).toBe(true);
    expect(await authorize({ ...undo, object: { ...undo.object, summary: 'private data' } })).toBe(
      false,
    );
    expect(mocks.mayFederate).not.toHaveBeenCalled();
  });
});
