import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The schema for channel accounts: `Post.writtenByOxyUserId` and
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
 * **That guarantee is now the ONLY thing keeping them off those surfaces.** The
 * previous version of this file was written as a verdict on whether
 * `EXCLUDE_CHANNEL_POSTS` — a flat `{ channelId: { $exists: false } }` term both
 * matchers carried — could be deleted. It found the field placement SUFFICIENT for
 * a channel-AUTHORED post and the clause still load-bearing for the old
 * person-authored shape, which was a DATA condition: no post may retain that
 * shape. A clean cut satisfied it (migration `0026-channel-accounts` unsets
 * `channelId` outright, and the rows that carried it were disposable), so the
 * clause is gone and the second block below now asserts the finished state rather
 * than the verdict. The third block is unchanged and is the important one: it
 * MUTATES the guarantee — moving the writer into `authorship[]` — and asserts the
 * damage, so the placement is shown to be load-bearing rather than merely true.
 */

vi.unmock('mongoose');

const mongoose = (await import('mongoose')).default;
const { Post } = await import('../../models/Post');
const { UserSettings } = await import('../../models/UserSettings');
const {
  buildAuthorFeedMatch,
  buildFollowedAuthorsMatch,
  getHeaderAuthorshipEntries,
} = await import('../../utils/postAuthorship');

/** The Oxy `channel` account that authors the post. */
const CHANNEL_ACCOUNT = 'oxy-channel-account';
/** The human who wrote it, and who must not be an author of it. */
const WRITER = 'oxy-writer';

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
    writtenByOxyUserId: WRITER,
    visibility: 'public',
    status: 'published',
    content: { variants: [{ source: 'author', text: 'from the channel' }] },
  });
  await post.save();
  return post._id.toString();
}

/** An ordinary post by the writer — every vacuity floor's control. */
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

  it('CONTROL: `channelId` is gone from the schema — a write of it is dropped', async () => {
    // The clean cut migration `0026` relies on: the field is undeclared, so it
    // cannot come back through a stray writer, and the matchers below need no
    // clause to exclude it.
    const post = new Post({
      oxyUserId: CHANNEL_ACCOUNT,
      authorship: [{ oxyUserId: CHANNEL_ACCOUNT, role: 'owner', status: 'accepted' }],
      channelId: 'channel-1',
      content: { variants: [{ source: 'author', text: 'x' }] },
    });
    await post.save();

    expect(await Post.collection.findOne({ _id: post._id })).not.toHaveProperty('channelId');
  });

  it('keeps the writer OUT of authorship[] — the channel is the only author', async () => {
    const id = await seedChannelAuthoredPost();

    const stored = await Post.findById(id).lean();

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
 * ## The finished state: the authorship half alone is the exclusion.
 *
 * Both author-relationship matchers are measured, because covering one would
 * answer half the question while reading as if it answered all of it:
 * `buildAuthorFeedMatch` is the profile feed and `buildFollowedAuthorsMatch` is
 * the following timeline.
 */
describe('a channel-authored post never reaches its writer\'s surfaces', () => {
  it('is absent from the writer\'s profile', async () => {
    await seedChannelAuthoredPost();

    expect(await Post.find(buildAuthorFeedMatch(WRITER)).lean()).toHaveLength(0);
  });

  it('is absent from the timelines of the writer\'s followers', async () => {
    await seedChannelAuthoredPost();

    expect(await Post.find(buildFollowedAuthorsMatch([WRITER])).lean()).toHaveLength(0);
  });

  it('VACUITY FLOOR: both matchers DO return an ordinary post by that author', async () => {
    // "Nothing came back" is otherwise satisfiable by a query that matches nothing
    // at all — a typo in either match would pass both assertions above.
    await seedChannelAuthoredPost();
    const ordinaryId = await seedOrdinaryPost();

    const onProfile = await Post.find(buildAuthorFeedMatch(WRITER)).lean();
    const onTimeline = await Post.find(buildFollowedAuthorsMatch([WRITER])).lean();

    expect(onProfile.map((post) => post._id.toString())).toEqual([ordinaryId]);
    expect(onTimeline.map((post) => post._id.toString())).toEqual([ordinaryId]);
  });

  it('DOES reach the CHANNEL\'s own profile and its followers', async () => {
    // The other half of the cut-over, and the reason the exclusion could go: the
    // post is not hidden from everyone, it belongs to a different author.
    const id = await seedChannelAuthoredPost();

    expect(
      (await Post.find(buildAuthorFeedMatch(CHANNEL_ACCOUNT)).lean()).map((post) =>
        post._id.toString(),
      ),
    ).toEqual([id]);
    expect(
      (await Post.find(buildFollowedAuthorsMatch([CHANNEL_ACCOUNT])).lean()).map((post) =>
        post._id.toString(),
      ),
    ).toEqual([id]);
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
      visibility: 'public',
      status: 'published',
      content: { variants: [{ source: 'author', text: 'from the channel' }] },
    });
    await post.save();
  }

  it('breaks anonymity: the byline now names the writer', async () => {
    await seedWriterAsCollaborator();

    const stored = await Post.findOne({ oxyUserId: CHANNEL_ACCOUNT }).lean();
    const byline = getHeaderAuthorshipEntries(stored?.authorship ?? []);

    expect(byline.map((entry) => entry.oxyUserId)).toEqual([CHANNEL_ACCOUNT, WRITER]);
  });

  it('puts the post back on the writer\'s profile and in their followers\' timelines', async () => {
    // This is the regression the field placement prevents, and with the old
    // `channelId` exclusion deleted there is nothing else left to catch it — the
    // damage would be immediate and visible rather than latent.
    await seedWriterAsCollaborator();

    expect(await Post.find(buildAuthorFeedMatch(WRITER)).lean()).toHaveLength(1);
    expect(await Post.find(buildFollowedAuthorsMatch([WRITER])).lean()).toHaveLength(1);
  });
});

describe('UserSettings.channel.signPosts', () => {
  it('round-trips through the database', async () => {
    await new UserSettings({ oxyUserId: CHANNEL_ACCOUNT, channel: { signPosts: true } }).save();

    const stored = await UserSettings.collection.findOne({ oxyUserId: CHANNEL_ACCOUNT });

    expect(stored?.channel).toEqual({ signPosts: true });
  });

  it('defaults to FALSE — a channel post is anonymous unless the owner says otherwise', async () => {
    // Backwards, it would publish every writer's identity by omission.
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
