/**
 * `community_bans` — the one thing Mention stores about a community it hosts.
 *
 * A community is an Oxy ACCOUNT (`kind: 'community'`): its members are its
 * moderators and Oxy's account graph is where they live, so there is no
 * `communities` or `community_moderators` table here, for the reason
 * `channels.ts` gives for channels — a second copy of membership goes stale
 * exactly when it matters.
 *
 * A ban is different: it is a decision the community's moderators make about a
 * person, which no other system holds. It refuses that person's posts and
 * replies in the community, from Mention and from the fediverse alike
 * (`services/communities/communityPosting.ts`), and the community `Block`s them.
 *
 * A REMOVED post needs no row: removal clears the post's
 * `community_oxy_user_id`, so it leaves the community's page and its members'
 * feeds by the same partial index that put it there, and stays its author's.
 */

import { index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { createdAt } from '@oxy.so/db';

export const communityBans = pgTable(
  'community_bans',
  {
    /** The community (an Oxy account id) — no foreign key. */
    communityOxyUserId: text().notNull(),
    /** The banned person (an Oxy account id) — no foreign key. */
    bannedOxyUserId: text().notNull(),
    /** The moderator who banned them, for the moderators' own record. */
    bannedByOxyUserId: text().notNull(),
    reason: text(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.communityOxyUserId, t.bannedOxyUserId] }),
    // Account erasure finds a person's bans by the banned id.
    index('community_bans_banned_idx').on(t.bannedOxyUserId),
  ],
);
