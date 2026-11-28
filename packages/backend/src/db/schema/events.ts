import { boolean, pgTable, text, unique, index } from 'drizzle-orm/pg-core';
import { createdAt, generatedId } from '@oxy.so/db';
import { posts } from './posts';

/** Personal attendance. Oxy owns identity; no copied account/profile facts. */
export const eventAttendance = pgTable(
  'event_attendance',
  {
    id: generatedId(),
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    oxyUserId: text().notNull(),
    public: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique('event_attendance_post_user_key').on(t.postId, t.oxyUserId),
    index('event_attendance_account_idx').on(t.oxyUserId),
  ],
);
