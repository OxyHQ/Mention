import { sql } from 'drizzle-orm';
import { check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList } from '@oxy.so/db';
import { membershipReports } from './memberships';

export const MEMBERSHIP_REVIEW_ACTIONS = [
  'inspect',
  'download_media',
  'remove_content',
  'suspend_community',
  'dismiss_report',
] as const;

/** No body, media URL or reporter identity is copied into the access ledger. */
export const membershipReviewAudits = pgTable(
  'membership_review_audits',
  {
    id: generatedId(),
    reportId: text()
      .notNull()
      .references(() => membershipReports.id, { onDelete: 'cascade' }),
    operatorOxyUserId: text(),
    action: text({ enum: MEMBERSHIP_REVIEW_ACTIONS }).notNull(),
    purpose: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('membership_review_audits_report_idx').on(t.reportId, t.createdAt),
    index('membership_review_audits_operator_idx').on(t.operatorOxyUserId),
    check(
      'membership_review_audits_action_check',
      sql`${t.action} in (${sql.raw(inList(MEMBERSHIP_REVIEW_ACTIONS))})`,
    ),
  ],
);
