import { CONTENT_CLASSIFICATIONS } from '@oxy.so/contracts';
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { inList, updatedAt } from '@oxy.so/db';
import { posts } from './posts';

/** One assessment of current material per post; a digest mismatch is never a rating. */
export const postSafetyAssessments = pgTable(
  'post_safety_assessments',
  {
    postId: text()
      .primaryKey()
      .references(() => posts.id, { onDelete: 'cascade' }),
    materialDigest: text().notNull(),
    rating: text({ enum: CONTENT_CLASSIFICATIONS }).notNull(),
    assessmentVersion: integer().notNull(),
    assessedAt: updatedAt(),
  },
  (table) => [
    check(
      'post_safety_rating_check',
      sql`${table.rating} in (${sql.raw(inList(CONTENT_CLASSIFICATIONS))})`,
    ),
    check('post_safety_digest_check', sql`${table.materialDigest} ~ '^[a-f0-9]{64}$'`),
    check('post_safety_version_check', sql`${table.assessmentVersion} > 0`),
  ],
);
