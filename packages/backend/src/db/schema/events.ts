// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
