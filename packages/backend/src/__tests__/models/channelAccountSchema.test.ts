import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The additive schema for channel accounts: `Post.writtenByOxyUserId` and
 * `UserSettings.channel.signPosts`.
 *
 * ## Why a real database rather than a constructed document
 *
 * The `Post` schema is STRICT, so an undeclared field is dropped SILENTLY — no
 * error, no warning, the write succeeds and the value is simply gone. A test that
 * constructs a document and reads the property back can be fooled by an in-memory
 * value that would never survive a save, so each field is written through its
 * model and read back out of Mongo. The author-relationship matchers are likewise
 * EXECUTED against real documents rather than inspected as objects: an assertion
 * on the shape of a match re-states the code instead of checking its effect, and
 * passes just as happily when the clause is present but wrong.
 *
 * ## The guarantee this file exists to defend
 *
 * `writtenByOxyUserId` must never migrate into `authorship[]`. That refactor is
 * tempting — it looks like consolidation — and it silently breaks the anonymity of
 * a `signPosts: false` channel AND puts channel posts back on their writer's own
 * profile and in their followers' timelines.
 *
 * That guarantee is also what decides whether `EXCLUDE_CHANNEL_POSTS` can be
 * DELETED, so the second describe block below is written as a verdict rather than
 * a regression test: it separates what the field placement already buys from the
 * one condition still outstanding. The third block is the mutation — the writer is
 * moved into `authorship[]` and the resulting damage asserted — so the guarantee
 * is shown to be load-bearing rather than merely true today.
 */

vi.unmock('mongoose');

const mongoose = (await import('mongoose')).default;
const { Post } = await import('../../models/Post');
const { UserSettings } = await import('../../models/UserSettings');
const {
  buildAuthorFeedMatch,
  buildFollowedAuthorsMatch,
  getHeaderAuthorshipEntries,
  EXCLUDE_CHANNEL_POSTS,
} = await import('../../utils/postAuthorship');

/** The Oxy `channel` account that authors the post once the cut-over has happened. */
const CHANNEL_ACCOUNT = 'oxy-channel-account';
/** The human who wrote it, and who must not be an author of it. */
const WRITER = 'oxy-writer';
const CHANNEL_ID = 'channel-1';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'channel-account-schema' });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

afterEach(async () => {
  await Promise.all([Post.deleteMany({}), UserSettings.deleteMany({})]);
});

/**
 * The SHAPE THIS FIELD EXISTS FOR: the channel account is the author, and the
 * human who wrote it is carried outside `authorship[]`.
 */
async function seedChannelAuthoredPost(): Promise<string> {
  const post = new Post({
    oxyUserId: CHANNEL_ACCOUNT,
    authorship: [{ oxyUserId: CHANNEL_ACCOUNT, role: 'owner', status: 'accepted' }],
    channelId: CHANNEL_ID,
    writtenByOxyUserId: WRITER,
    visibility: 'public',
    status: 'published',
    content: { variants: [{ source: 'author', text: 'from the channel' }] },
  });
  await post.save();
  return post._id.toString();
}

/**
 * The shape channel posts have TODAY, before the cut-over: the human is the
 * author and `channelId` is the only thing marking it as a channel post. Nothing
 * but `EXCLUDE_CHANNEL_POSTS` keeps one of these off its author's own surfaces —
 * which is why the clause exists, and the condition still outstanding before it
 * can be deleted.
 */
async function seedPersonAuthoredChannelPost(): Promise<void> {
  const post = new Post({
    oxyUserId: WRITER,
    authorship: [{ oxyUserId: WRITER, role: 'owner', status: 'accepted' }],
    channelId: CHANNEL_ID,
    visibility: 'public',
    status: 'published',
    content: { variants: [{ source: 'author', text: 'legacy channel post' }] },
  });
  await post.save();
}

/** An ordinary post by the writer, on no channel — every vacuity floor's control. */
async function seedOrdinaryPost(): Promise<string> {
  const post = new Post({
    oxyUserId: WRITER,
    authorship: [{ oxyUserId: WRITER, role: 'owner', status: 'accepted' }],
    visibility: 'public',
    status: 'published',
    content: { variants: [{ source: 'author', text: 'my own post' }] },
  });
  await post.save();
  return post._id.toString();
}

/**
 * A matcher with the channel exclusion REMOVED — its authorship half on its own,
 * i.e. what the query would become the day `EXCLUDE_CHANNEL_POSTS` is deleted.
 *
 * Derived from the real matcher rather than re-stated, so it cannot drift from it,
 * and the derivation is checked to have actually removed something — a no-op strip
 * would make every assertion built on it meaningless.
 */
function withoutChannelExclusion(match: Record<string, unknown>): Record<string, unknown> {
  const half = { ...match };
  for (const key of Object.keys(EXCLUDE_CHANNEL_POSTS)) {
    delete half[key];
  }
  expect(Object.keys(half).length).toBeLessThan(Object.keys(match).length);
  return half;
}

describe('Post.writtenByOxyUserId', () => {
  it('round-trips through the database — the strict schema does not drop it', async () => {
    const id = await seedChannelAuthoredPost();

    const stored = await Post.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

    expect(stored?.writtenByOxyUserId).toBe(WRITER);
  });

  it('CONTROL: an undeclared field IS dropped, so the assertion above can fail', async () => {
    // Without this, "the value came back" proves nothing: it would read the same
    // way if strict mode were off and every field survived regardless.
    const post = new Post({
      oxyUserId: CHANNEL_ACCOUNT,
      authorship: [{ oxyUserId: CHANNEL_ACCOUNT, role: 'owner', status: 'accepted' }],
      writtenByOxyUserId: WRITER,
      penNameOxyUserId: WRITER,
      content: { variants: [{ source: 'author', text: 'x' }] },
    });
    await post.save();

    const stored = await Post.collection.findOne({ _id: post._id });

    expect(stored?.writtenByOxyUserId).toBe(WRITER);
    expect(stored).not.toHaveProperty('penNameOxyUserId');
  });

  it('keeps the writer OUT of authorship[] — the channel is the only author', async () => {
    await seedChannelAuthoredPost();

    const stored = await Post.findOne({ channelId: CHANNEL_ID }).lean();

    expect(stored?.authorship).toEqual([
      { oxyUserId: CHANNEL_ACCOUNT, role: 'owner', status: 'accepted' },
    ]);
    expect(stored?.authorship?.some((entry) => entry.oxyUserId === WRITER)).toBe(false);
  });

  it('does not name the writer in the post byline', async () => {
    const stored = await Post.findById(await seedChannelAuthoredPost()).lean();

    const byline = getHeaderAuthorshipEntries(stored?.authorship ?? []);

    expect(byline.map((entry) => entry.oxyUserId)).toEqual([CHANNEL_ACCOUNT]);
  });
});

/**
 * ## Verdict: can `EXCLUDE_CHANNEL_POSTS` be deleted?
 *
 * The clause is a flat `{ channelId: { $exists: false } }` term carried by BOTH
 * author-relationship matchers — `buildAuthorFeedMatch` (the profile feed) and
 * `buildFollowedAuthorsMatch` (the following timeline). Deleting it requires both
 * to be safe without it, so both are measured here; testing only the profile would
 * answer half the question while reading as if it answered all of it.
 *
 * **Sufficient, already true:** for a post authored BY the channel account, the
 * authorship half alone excludes it from both surfaces. The clause is redundant
 * for that shape. This is exactly what keeping the writer out of `authorship[]`
 * buys, and the mutation block below shows it is the only reason it holds.
 *
 * **Still outstanding:** a post authored by the PERSON with `channelId` set — the
 * shape every channel post has today — is held back by NOTHING ELSE. Deleting the
 * clause while one such row exists puts it straight back on its author's profile
 * and in their followers' timelines. So the precondition is not "the field
 * exists", it is "no post retains the person-authored shape" — a DATA condition,
 * which a clean cut with no rows worth preserving satisfies outright.
 */
describe('EXCLUDE_CHANNEL_POSTS — deletable for the new shape, blocked by the old one', () => {
  it('SUFFICIENT (profile): the authorship half alone excludes a channel-authored post', async () => {
    await seedChannelAuthoredPost();

    const matched = await Post.find(withoutChannelExclusion(buildAuthorFeedMatch(WRITER))).lean();

    expect(matched).toHaveLength(0);
  });

  it('SUFFICIENT (following): the authorship half alone excludes it there too', async () => {
    await seedChannelAuthoredPost();

    const matched = await Post.find(
      withoutChannelExclusion(buildFollowedAuthorsMatch([WRITER])),
    ).lean();

    expect(matched).toHaveLength(0);
  });

  it('VACUITY FLOOR: both halved matchers DO return an ordinary post by that author', async () => {
    // "Nothing came back" is otherwise satisfiable by a query that matches nothing
    // at all — a typo in either match would pass both assertions above.
    await seedChannelAuthoredPost();
    const ordinaryId = await seedOrdinaryPost();

    const onProfile = await Post.find(withoutChannelExclusion(buildAuthorFeedMatch(WRITER))).lean();
    const onTimeline = await Post.find(
      withoutChannelExclusion(buildFollowedAuthorsMatch([WRITER])),
    ).lean();

    expect(onProfile.map((post) => post._id.toString())).toEqual([ordinaryId]);
    expect(onTimeline.map((post) => post._id.toString())).toEqual([ordinaryId]);
  });

  it('BLOCKER (profile): a PERSON-authored channel post is held back by the clause and nothing else', async () => {
    // The shape every channel post has today. This is the one condition standing
    // between the clause and its deletion — and it is a data condition, not a code
    // one, so a clean cut with no rows to preserve satisfies it.
    await seedPersonAuthoredChannelPost();

    expect(await Post.find(buildAuthorFeedMatch(WRITER)).lean()).toHaveLength(0);
    expect(
      await Post.find(withoutChannelExclusion(buildAuthorFeedMatch(WRITER))).lean(),
    ).toHaveLength(1);
  });

  it('BLOCKER (following): the same row returns to the followers timeline without the clause', async () => {
    await seedPersonAuthoredChannelPost();

    expect(await Post.find(buildFollowedAuthorsMatch([WRITER])).lean()).toHaveLength(0);
    expect(
      await Post.find(withoutChannelExclusion(buildFollowedAuthorsMatch([WRITER]))).lean(),
    ).toHaveLength(1);
  });

  it('keeps a channel-authored post off the writer\'s surfaces WITH the clause in place too', async () => {
    // The shipped behaviour today, unchanged by this step.
    await seedChannelAuthoredPost();

    expect(await Post.find(buildAuthorFeedMatch(WRITER)).lean()).toHaveLength(0);
    expect(await Post.find(buildFollowedAuthorsMatch([WRITER])).lean()).toHaveLength(0);
  });
});

describe('MUTATION — the writer moved into authorship[]', () => {
  /** The "tidied" shape: writer as a co-author instead of a top-level field. */
  async function seedWriterAsCollaborator(): Promise<void> {
    const post = new Post({
      oxyUserId: CHANNEL_ACCOUNT,
      authorship: [
        { oxyUserId: CHANNEL_ACCOUNT, role: 'owner', status: 'accepted' },
        { oxyUserId: WRITER, role: 'collaborator', status: 'accepted' },
      ],
      channelId: CHANNEL_ID,
      visibility: 'public',
      status: 'published',
      content: { variants: [{ source: 'author', text: 'from the channel' }] },
    });
    await post.save();
  }

  it('breaks anonymity: the byline now names the writer', async () => {
    await seedWriterAsCollaborator();

    const stored = await Post.findOne({ channelId: CHANNEL_ID }).lean();
    const byline = getHeaderAuthorshipEntries(stored?.authorship ?? []);

    expect(byline.map((entry) => entry.oxyUserId)).toEqual([CHANNEL_ACCOUNT, WRITER]);
  });

  it('makes EXCLUDE_CHANNEL_POSTS permanent: both surfaces would depend on it again', async () => {
    // This is the regression the field placement prevents, and the reason it
    // decides the clause's fate: the damage is invisible while the clause exists,
    // so the clause could never be removed afterwards — it would be load-bearing
    // again, for every channel post, forever.
    await seedWriterAsCollaborator();

    expect(
      await Post.find(withoutChannelExclusion(buildAuthorFeedMatch(WRITER))).lean(),
    ).toHaveLength(1);
    expect(
      await Post.find(withoutChannelExclusion(buildFollowedAuthorsMatch([WRITER]))).lean(),
    ).toHaveLength(1);

    // Still hidden today — which is precisely why nothing would notice.
    expect(await Post.find(buildAuthorFeedMatch(WRITER)).lean()).toHaveLength(0);
    expect(await Post.find(buildFollowedAuthorsMatch([WRITER])).lean()).toHaveLength(0);
  });
});

describe('UserSettings.channel.signPosts', () => {
  it('round-trips through the database', async () => {
    await new UserSettings({ oxyUserId: CHANNEL_ACCOUNT, channel: { signPosts: true } }).save();

    const stored = await UserSettings.collection.findOne({ oxyUserId: CHANNEL_ACCOUNT });

    expect(stored?.channel).toEqual({ signPosts: true });
  });

  it('defaults to FALSE — a channel post is anonymous unless the owner says otherwise', async () => {
    // Same default as `Channel.signPosts`. Backwards, it would publish every
    // writer's identity by omission.
    await new UserSettings({ oxyUserId: CHANNEL_ACCOUNT, channel: {} }).save();

    const stored = await UserSettings.findOne({ oxyUserId: CHANNEL_ACCOUNT }).lean();

    expect(stored?.channel?.signPosts).toBe(false);
  });

  it('stays ABSENT on a person\'s settings rather than defaulting a channel subdoc onto them', async () => {
    await new UserSettings({ oxyUserId: WRITER }).save();

    const stored = await UserSettings.collection.findOne({ oxyUserId: WRITER });

    expect(stored).not.toHaveProperty('channel');
  });
});
