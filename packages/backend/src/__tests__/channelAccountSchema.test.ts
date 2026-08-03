import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, type SQL } from 'drizzle-orm';

/**
 * The additive schema for channel accounts: `posts.written_by_oxy_user_id` and
 * `user_settings.channel_account_sign_posts`.
 *
 * ## The guarantee this file exists to defend
 *
 * `writtenByOxyUserId` must never migrate into `post_authorships`. That refactor
 * is tempting — it looks like consolidation — and it silently breaks the
 * anonymity of a `signPosts: false` channel AND puts channel posts back on their
 * writer's own profile and in their followers' timelines.
 *
 * That guarantee USED to decide whether the `channel_id is null` exclusion inside
 * `authorFeedSql` / `followedAuthorsSql` could be deleted. It has been: a channel
 * is an Oxy ACCOUNT that authors its own posts, so `posts.channel_id` and the
 * clause that read it were both dropped by `0017_a_channel_is_an_account`. The
 * column placement is therefore no longer merely SUFFICIENT — it is the ONLY
 * thing holding the property up, which is what the mutation block below now
 * shows: with no exclusion left to hide the damage, moving the writer into
 * `post_authorships` puts the post on their profile for real.
 *
 * Against REAL ROWS rather than a Mongoose strict-schema round trip. The failure
 * this guards is not "a schema dropped the field" — it is "the field ended up
 * somewhere that changes which queries match", and only executing those queries
 * can tell.
 */

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postAuthorships } from '../db/schema/postContent';
import { userSettings } from '../db/schema/userProfile';
import { clearPostScope, postScope, seedPost } from './helpers/postFixtures';
import {
  authorFeedSql,
  followedAuthorsSql,
  getHeaderAuthorshipEntries,
} from '../utils/postAuthorship';
import { loadUserSettings, updateUserSettings } from '../db/userProfile/userSettingsRepository';

const scope = postScope('channel-account-schema');
const CHANNEL_ACCOUNT = scope.user('channel-account');
const WRITER = scope.user('writer');
const settingsOwners: string[] = [];

/**
 * The shape as designed: the CHANNEL authors, the writer is a plain column.
 *
 * `CHANNEL_ACCOUNT` is an ordinary `oxyUserId` and there is no channel row to
 * seed — that IS the design. A channel is an Oxy account, so "a post that
 * belongs to a channel" is a post the channel authored.
 */
async function seedChannelAuthoredPost() {
  return seedPost(scope, {
    oxyUserId: CHANNEL_ACCOUNT,
    authorship: [{ oxyUserId: CHANNEL_ACCOUNT, role: 'owner', status: 'accepted' }],
    writtenByOxyUserId: WRITER,
    content: { variants: [{ source: 'author', text: 'from the channel', tag: 'en' }] },
  });
}

/** The "tidied" shape: writer as a co-author instead of a top-level column. */
async function seedWriterAsCollaborator() {
  return seedPost(scope, {
    oxyUserId: CHANNEL_ACCOUNT,
    authorship: [
      { oxyUserId: CHANNEL_ACCOUNT, role: 'owner', status: 'accepted' },
      { oxyUserId: WRITER, role: 'collaborator', status: 'accepted' },
    ],
    content: { variants: [{ source: 'author', text: 'from the channel', tag: 'en' }] },
  });
}

/** Post ids matching a predicate, scoped to this suite's rows. */
async function matching(where: SQL, ids: string[]): Promise<string[]> {
  const rows = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .where(and(inArray(posts.id, ids), where));
  return rows.map((row) => row.id);
}

/**
 * The authorship join, written out by hand.
 *
 * It used to be "the author matcher with its channel exclusion removed", to
 * decide whether that exclusion was redundant. It was, and it is gone — so this
 * is now simply an independent spelling of what `authorFeedSql` does, kept
 * because a hand-written join is what makes the mutation block's damage legible
 * without asking the reader to trust the helper being mutated.
 */
async function matchingByAuthorshipJoin(userId: string, ids: string[]): Promise<string[]> {
  const rows = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(postAuthorships, eq(postAuthorships.postId, posts.id))
    .where(
      and(
        inArray(posts.id, ids),
        eq(postAuthorships.oxyUserId, userId),
        eq(postAuthorships.status, 'accepted'),
      ),
    );
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearPostScope(scope);
  const owners = settingsOwners.splice(0);
  if (owners.length > 0) {
    await getDb().delete(userSettings).where(inArray(userSettings.oxyUserId, owners));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('posts.written_by_oxy_user_id', () => {
  it('round-trips through the database', async () => {
    const post = await seedChannelAuthoredPost();

    const [row] = await getDb()
      .select({ writtenBy: posts.writtenByOxyUserId })
      .from(posts)
      .where(eq(posts.id, post.id));
    expect(row?.writtenBy).toBe(WRITER);
  });

  it('is NULL on an ordinary post, so "no writer" is one state and not two', async () => {
    const post = await seedPost(scope, { oxyUserId: CHANNEL_ACCOUNT });
    const [row] = await getDb()
      .select({ writtenBy: posts.writtenByOxyUserId })
      .from(posts)
      .where(eq(posts.id, post.id));
    expect(row?.writtenBy).toBeNull();
  });

  it('keeps the writer OUT of post_authorships — the channel is the only author', async () => {
    const post = await seedChannelAuthoredPost();

    const rows = await getDb()
      .select({ oxyUserId: postAuthorships.oxyUserId })
      .from(postAuthorships)
      .where(eq(postAuthorships.postId, post.id));
    expect(rows.map((r) => r.oxyUserId)).toEqual([CHANNEL_ACCOUNT]);
  });

  it('does not name the writer in the post byline', async () => {
    const byline = getHeaderAuthorshipEntries([
      { oxyUserId: CHANNEL_ACCOUNT, role: 'owner', status: 'accepted' },
    ]);
    expect(byline.map((entry) => entry.oxyUserId)).toEqual([CHANNEL_ACCOUNT]);
  });
});

describe('the channel exclusion — deletable for the new shape, blocked by the old one', () => {
  it('SUFFICIENT: the authorship half ALONE excludes a channel-authored post', async () => {
    const post = await seedChannelAuthoredPost();

    // No `channel_id is null` term anywhere here: the writer simply is not an
    // author of this row, so the authorship join finds nothing for them.
    expect(await matchingByAuthorshipJoin(WRITER, [post.id])).toEqual([]);
  });

  it('VACUITY FLOOR: the halved matcher DOES return an ordinary post by that author', async () => {
    // Without this, the case above passes just as well against a matcher that
    // returns nothing for anybody.
    const ordinary = await seedPost(scope, { oxyUserId: WRITER });
    expect(await matchingByAuthorshipJoin(WRITER, [ordinary.id])).toEqual([ordinary.id]);
  });

  it('keeps a channel-authored post off the writer\'s surfaces WITH the clause too', async () => {
    const post = await seedChannelAuthoredPost();

    expect(await matching(authorFeedSql(WRITER), [post.id])).toEqual([]);
    expect(await matching(followedAuthorsSql([WRITER]), [post.id])).toEqual([]);
  });
});

/**
 * MUTATION — the writer moved into `post_authorships`.
 *
 * This is the refactor that looks like consolidation. Both halves of the damage
 * are asserted against REAL QUERIES: the byline names them, and the post lands
 * on their own profile and in their followers' timelines.
 */
describe('MUTATION — the writer moved into post_authorships', () => {
  it('breaks anonymity: the byline now names the writer', async () => {
    const byline = getHeaderAuthorshipEntries([
      { oxyUserId: CHANNEL_ACCOUNT, role: 'owner', status: 'accepted' },
      { oxyUserId: WRITER, role: 'collaborator', status: 'accepted' },
    ]);
    expect(byline.map((entry) => entry.oxyUserId)).toEqual([CHANNEL_ACCOUNT, WRITER]);
  });

  it('puts the channel\'s post on the WRITER\'s own surfaces', async () => {
    // The damage, in full, and no longer latent.
    //
    // While `channel_id is null` still stood inside these matchers, this same
    // mutation was INVISIBLE: the clause hid the post, so nothing went red and
    // the clause could never afterwards be removed — it would have been
    // load-bearing again, for every channel post, forever. That clause is gone
    // (`0017_a_channel_is_an_account`), so the authorship placement is now the
    // ONLY thing holding this property up, and breaking it shows immediately.
    //
    // Read the three assertions together: they are the profile feed and the
    // followers' timeline of a person a `signPosts: false` channel exists to
    // keep anonymous.
    const post = await seedWriterAsCollaborator();

    expect(await matchingByAuthorshipJoin(WRITER, [post.id])).toEqual([post.id]);
    expect(await matching(authorFeedSql(WRITER), [post.id])).toEqual([post.id]);
    expect(await matching(followedAuthorsSql([WRITER]), [post.id])).toEqual([post.id]);
  });

  it('CONTROL: the designed shape keeps that same post off both surfaces', async () => {
    // The other half of the mutation — same channel, same writer, the writer in
    // `written_by_oxy_user_id` instead of `post_authorships`. Without this the
    // case above could pass against a matcher that returns everything.
    const post = await seedChannelAuthoredPost();

    expect(await matchingByAuthorshipJoin(WRITER, [post.id])).toEqual([]);
    expect(await matching(authorFeedSql(WRITER), [post.id])).toEqual([]);
    expect(await matching(followedAuthorsSql([WRITER]), [post.id])).toEqual([]);
  });
});

describe('user_settings.channel_account_sign_posts', () => {
  it('round-trips, and stores FALSE distinctly from absent', async () => {
    settingsOwners.push(CHANNEL_ACCOUNT);
    await updateUserSettings(CHANNEL_ACCOUNT, { set: { 'channelAccount.signPosts': false } });
    expect((await loadUserSettings(CHANNEL_ACCOUNT))?.channelAccount).toEqual({
      signPosts: false,
    });

    await updateUserSettings(CHANNEL_ACCOUNT, { set: { 'channelAccount.signPosts': true } });
    expect((await loadUserSettings(CHANNEL_ACCOUNT))?.channelAccount).toEqual({
      signPosts: true,
    });
  });

  it('stays ABSENT on a person\'s settings rather than defaulting a channel onto them', async () => {
    // The presence of the object is what says "this account is a channel". A
    // `NOT NULL DEFAULT false` column would make every person read as a channel
    // that does not sign, and the two states would be indistinguishable
    // everywhere downstream.
    settingsOwners.push(WRITER);
    await updateUserSettings(WRITER, { set: { 'privacy.showSensitiveContent': false } });
    expect((await loadUserSettings(WRITER))?.channelAccount).toBeUndefined();
  });
});
