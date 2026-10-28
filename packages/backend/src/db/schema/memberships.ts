/** Protected membership content never enters posts, public search or MTN records. */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import {
  MEMBERSHIP_BENEFITS,
  MEMBERSHIP_COMMUNITY_STATES,
  MEMBERSHIP_CONTENT_KINDS,
  MEMBERSHIP_STATES,
  MEMBERSHIP_TIER_STATES,
} from '@mention/shared-types';

export const membershipCommunities = pgTable(
  'membership_communities',
  {
    id: generatedId(),
    ownerOxyUserId: text().notNull(),
    slug: text().notNull(),
    name: text().notNull(),
    description: text().notNull().default(''),
    visibility: text({ enum: ['public', 'unlisted'] })
      .notNull()
      .default('public'),
    status: text({ enum: MEMBERSHIP_COMMUNITY_STATES }).notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('membership_communities_slug_key').on(t.slug),
    index('membership_communities_owner_idx').on(t.ownerOxyUserId),
    check(
      'membership_communities_visibility_check',
      sql`${t.visibility} in ('public', 'unlisted')`,
    ),
    check(
      'membership_communities_status_check',
      sql`${t.status} in (${sql.raw(inList(MEMBERSHIP_COMMUNITY_STATES))})`,
    ),
  ],
);

export const membershipTiers = pgTable(
  'membership_tiers',
  {
    id: generatedId(),
    communityId: text()
      .notNull()
      .references(() => membershipCommunities.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text().notNull().default(''),
    kind: text({ enum: ['free', 'paid'] }).notNull(),
    status: text({ enum: MEMBERSHIP_TIER_STATES }).notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('membership_tiers_id_community_key').on(t.id, t.communityId),
    uniqueIndex('membership_tiers_one_free_idx')
      .on(t.communityId)
      .where(sql`${t.kind} = 'free' and ${t.status} <> 'retired'`),
    index('membership_tiers_community_idx').on(t.communityId),
    check('membership_tiers_kind_check', sql`${t.kind} in ('free', 'paid')`),
    check(
      'membership_tiers_status_check',
      sql`${t.status} in (${sql.raw(inList(MEMBERSHIP_TIER_STATES))})`,
    ),
    // Commercial terms/provider bindings have not been approved. No paid activation can slip through another writer.
    check('membership_tiers_paid_draft_check', sql`${t.kind} <> 'paid' or ${t.status} <> 'active'`),
  ],
);
export const membershipTierBenefits = pgTable(
  'membership_tier_benefits',
  {
    tierId: text()
      .notNull()
      .references(() => membershipTiers.id, { onDelete: 'cascade' }),
    benefit: text({ enum: MEMBERSHIP_BENEFITS }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tierId, t.benefit] }),
    check(
      'membership_tier_benefits_benefit_check',
      sql`${t.benefit} in (${sql.raw(inList(MEMBERSHIP_BENEFITS))})`,
    ),
  ],
);

export const communityMemberships = pgTable(
  'community_memberships',
  {
    id: generatedId(),
    communityId: text()
      .notNull()
      .references(() => membershipCommunities.id, { onDelete: 'cascade' }),
    memberOxyUserId: text().notNull(),
    tierId: text().notNull(),
    state: text({ enum: MEMBERSHIP_STATES }).notNull().default('active'),
    publicBadge: boolean().notNull().default(false),
    startedAt: timestamptz().notNull().defaultNow(),
    accessEndsAt: timestamptz(),
    cancelledAt: timestamptz(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('community_memberships_account_key').on(t.communityId, t.memberOxyUserId),
    index('community_memberships_member_idx').on(t.memberOxyUserId),
    index('community_memberships_tier_idx').on(t.tierId),
    foreignKey({
      columns: [t.tierId, t.communityId],
      foreignColumns: [membershipTiers.id, membershipTiers.communityId],
    }).onDelete('cascade'),
    check(
      'community_memberships_state_check',
      sql`${t.state} in (${sql.raw(inList(MEMBERSHIP_STATES))})`,
    ),
    check(
      'community_memberships_grace_end_check',
      sql`${t.state} <> 'grace_period' or ${t.accessEndsAt} is not null`,
    ),
  ],
);

export const membershipContents = pgTable(
  'membership_contents',
  {
    id: generatedId(),
    communityId: text()
      .notNull()
      .references(() => membershipCommunities.id, { onDelete: 'cascade' }),
    authorOxyUserId: text().notNull(),
    parentContentId: text(),
    kind: text({ enum: MEMBERSHIP_CONTENT_KINDS }).notNull(),
    title: text(),
    body: text().notNull(),
    teaser: text(),
    removedAt: timestamptz(),
    pollEndsAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('membership_contents_id_community_key').on(t.id, t.communityId),
    foreignKey({
      columns: [t.parentContentId, t.communityId],
      foreignColumns: [t.id, t.communityId],
    }).onDelete('cascade'),
    index('membership_contents_community_page_idx').on(t.communityId, t.createdAt, t.id),
    index('membership_contents_author_idx').on(t.authorOxyUserId),
    index('membership_contents_parent_idx').on(t.parentContentId),
    check(
      'membership_contents_kind_check',
      sql`${t.kind} in (${sql.raw(inList(MEMBERSHIP_CONTENT_KINDS))})`,
    ),
    check(
      'membership_contents_poll_end_check',
      sql`(${t.kind} = 'poll') = (${t.pollEndsAt} is not null)`,
    ),
  ],
);
export const membershipContentTiers = pgTable(
  'membership_content_tiers',
  {
    communityId: text()
      .notNull()
      .references(() => membershipCommunities.id, { onDelete: 'cascade' }),
    contentId: text()
      .notNull()
      .references(() => membershipContents.id, { onDelete: 'cascade' }),
    tierId: text()
      .notNull()
      .references(() => membershipTiers.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.contentId, t.tierId] }),
    foreignKey({
      columns: [t.contentId, t.communityId],
      foreignColumns: [membershipContents.id, membershipContents.communityId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tierId, t.communityId],
      foreignColumns: [membershipTiers.id, membershipTiers.communityId],
    }).onDelete('cascade'),
    index('membership_content_tiers_tier_idx').on(t.tierId),
  ],
);

export const membershipMedia = pgTable(
  'membership_media',
  {
    id: generatedId(),
    communityId: text()
      .notNull()
      .references(() => membershipCommunities.id, { onDelete: 'cascade' }),
    contentId: text().references(() => membershipContents.id, { onDelete: 'cascade' }),
    ownerOxyUserId: text().notNull(),
    /** Oxy Files foreign service identity. Only verified private uploads enter this table. */
    fileId: text().notNull(),
    mime: text().notNull(),
    size: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.contentId, t.communityId],
      foreignColumns: [membershipContents.id, membershipContents.communityId],
    }).onDelete('cascade'),
    index('membership_media_content_idx').on(t.contentId),
    index('membership_media_community_idx').on(t.communityId),
    index('membership_media_owner_idx').on(t.ownerOxyUserId),
    check('membership_media_size_check', sql`${t.size} >= 0`),
  ],
);

export const membershipPollOptions = pgTable(
  'membership_poll_options',
  {
    id: generatedId(),
    contentId: text()
      .notNull()
      .references(() => membershipContents.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    text: text().notNull(),
  },
  (t) => [
    unique('membership_poll_options_position_key').on(t.contentId, t.position),
    unique('membership_poll_options_content_key').on(t.id, t.contentId),
    check('membership_poll_options_position_check', sql`${t.position} >= 0`),
  ],
);
export const membershipPollVotes = pgTable(
  'membership_poll_votes',
  {
    id: generatedId(),
    contentId: text()
      .notNull()
      .references(() => membershipContents.id, { onDelete: 'cascade' }),
    voterOxyUserId: text().notNull(),
    optionId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('membership_poll_votes_member_key').on(t.contentId, t.voterOxyUserId),
    foreignKey({
      columns: [t.optionId, t.contentId],
      foreignColumns: [membershipPollOptions.id, membershipPollOptions.contentId],
    }).onDelete('cascade'),
    index('membership_poll_votes_voter_idx').on(t.voterOxyUserId),
    index('membership_poll_votes_option_idx').on(t.optionId),
  ],
);

/** Local protected reports; bodies/evidence are never sent to public CrowdSource contracts. */
export const membershipReports = pgTable(
  'membership_reports',
  {
    id: generatedId(),
    contentId: text()
      .notNull()
      .references(() => membershipContents.id, { onDelete: 'cascade' }),
    reporterOxyUserId: text().notNull(),
    reason: text().notNull(),
    resolvedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('membership_reports_reporter_key').on(t.contentId, t.reporterOxyUserId),
    index('membership_reports_reporter_idx').on(t.reporterOxyUserId),
  ],
);
