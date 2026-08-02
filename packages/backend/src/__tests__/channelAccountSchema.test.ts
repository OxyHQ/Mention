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
 * That guarantee is also what decides whether the `channel_id is null` exclusion
 * inside `authorFeedSql` / `followedAuthorsSql` can eventually be DELETED, so the
 * second block below is written as a verdict rather than a regression test: it
 * separates what the column placement already buys from the one condition still
 * outstanding. The third block is the MUTATION — the writer moved into
 * `post_authorships` and the resulting damage asserted — so the guarantee is
 * shown to be load-bearing rather than merely true today.
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
import { clearPostScope, postScope, seedChannel, seedPost } from './helpers/postFixtures';
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

/** The shape as designed: the CHANNEL authors, the writer is a plain column. */
async function seedChannelAuthoredPost(channelId: string) {
  return seedPost(scope, {
    oxyUserId: CHANNEL_ACCOUNT,
    authorship: [{ oxyUserId: CHANNEL_ACCOUNT, role: 'owner', status: 'accepted' }],
    writtenByOxyUserId: WRITER,
    channelId,
    content: { variants: [{ source: 'author', text: 'from the channel', tag: 'en' }] },
  });
}

/** The "tidied" shape: writer as a co-author instead of a top-level column. */
async function seedWriterAsCollaborator(channelId: string) {
  return seedPost(scope, {
    oxyUserId: CHANNEL_ACCOUNT,
    authorship: [
      { oxyUserId: CHANNEL_ACCOUNT, role: 'owner', status: 'accepted' },
      { oxyUserId: WRITER, role: 'collaborator', status: 'accepted' },
    ],
    channelId,
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
 * The author matcher with its CHANNEL EXCLUSION REMOVED — the authorship half
 * alone. This is the clause under verdict: if the halved matcher already
 * excludes a channel-authored post, the exclusion is redundant and deletable.
 */
async function matchingWithoutChannelExclusion(userId: string, ids: string[]): Promise<string[]> {
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
    const post = await seedChannelAuthoredPost(await seedChannel(scope));

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
    const post = await seedChannelAuthoredPost(await seedChannel(scope));

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
    const post = await seedChannelAuthoredPost(await seedChannel(scope));

    // No `channel_id is null` term anywhere here: the writer simply is not an
    // author of this row, so the authorship join finds nothing for them.
    expect(await matchingWithoutChannelExclusion(WRITER, [post.id])).toEqual([]);
  });

  it('VACUITY FLOOR: the halved matcher DOES return an ordinary post by that author', async () => {
    // Without this, the case above passes just as well against a matcher that
    // returns nothing for anybody.
    const ordinary = await seedPost(scope, { oxyUserId: WRITER });
    expect(await matchingWithoutChannelExclusion(WRITER, [ordinary.id])).toEqual([ordinary.id]);
  });

  it('keeps a channel-authored post off the writer\'s surfaces WITH the clause too', async () => {
    const post = await seedChannelAuthoredPost(await seedChannel(scope));

    expect(await matching(authorFeedSql(WRITER), [post.id])).toEqual([]);
    expect(await matching(followedAuthorsSql([WRITER]), [post.id])).toEqual([]);
  });
});

describe('MUTATION — the writer moved into post_authorships', () => {
  it('breaks anonymity: the byline now names the writer', async () => {
    const byline = getHeaderAuthorshipEntries([
      { oxyUserId: CHANNEL_ACCOUNT, role: 'owner', status: 'accepted' },
      { oxyUserId: WRITER, role: 'collaborator', status: 'accepted' },
    ]);
    expect(byline.map((entry) => entry.oxyUserId)).toEqual([CHANNEL_ACCOUNT, WRITER]);
  });

  it('makes the channel exclusion PERMANENT: the surfaces would depend on it again', async () => {
    // This is the regression the column placement prevents, and the reason it
    // decides the clause's fate: the damage is invisible while the clause
    // exists, so the clause could never be removed afterwards — it would be
    // load-bearing again, for every channel post, forever.
    const post = await seedWriterAsCollaborator(await seedChannel(scope));

    expect(await matchingWithoutChannelExclusion(WRITER, [post.id])).toEqual([post.id]);

    // Still hidden today — which is precisely why nothing would notice.
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
