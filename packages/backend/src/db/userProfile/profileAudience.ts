/**
 * May an account's posts leave the audience the account chose?
 *
 * The ONE answer to that question, in the two shapes its readers need: a set of
 * account ids for code that already holds posts (ActivityPub collections and
 * delivery), and a SQL predicate for code that selects posts (trends, Jev).
 *
 * A `private` or `followers_only` profile (`user_settings.privacy_profile_visibility`)
 * limits every post the account writes to the people it lets in, whatever the
 * post's own visibility says: `PostHydrationService` hides such a post from
 * anyone who does not follow the author. Anything that carries a post to people
 * Mention does not check — an unsigned ActivityPub fetch, a remote follower
 * (remote follows are accepted automatically, so a remote follower is anyone
 * who asks), a trend label or an LLM summary read by everyone — is outside that
 * audience. So those posts stay home. No settings row reads as public, the
 * column's default.
 */

import { and, eq, inArray, ne, notExists, type AnyColumn, type SQL } from 'drizzle-orm';
import { getDb } from '../postgres';
import { posts } from '../schema/posts';
import { userSettings } from '../schema/userProfile';

/** The accounts among `accountIds` whose posts must not leave their audience. */
export async function accountsWithClosedAudience(
  accountIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(accountIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await getDb()
    .select({ oxyUserId: userSettings.oxyUserId })
    .from(userSettings)
    .where(
      and(
        inArray(userSettings.oxyUserId, ids),
        ne(userSettings.privacyProfileVisibility, 'public'),
      ),
    );
  return new Set(rows.map((row) => row.oxyUserId));
}

/** SQL twin of {@link accountsWithClosedAudience}: the author's posts may leave its audience. */
export function openAudienceAuthorSql(author: AnyColumn = posts.oxyUserId): SQL {
  return notExists(
    getDb()
      .select({ id: userSettings.oxyUserId })
      .from(userSettings)
      .where(
        and(
          eq(userSettings.oxyUserId, author),
          ne(userSettings.privacyProfileVisibility, 'public'),
        ),
      ),
  );
}
