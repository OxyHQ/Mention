// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { DeckWorkspaceState } from '@mention/shared-types/deck';
import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from '@oxy.so/db';

/** Versioned private UI document; see CONVENTIONS.md's scoped snapshot exception. */
export const deckWorkspaces = pgTable(
  'deck_workspaces',
  {
    oxyUserId: text().primaryKey(),
    revision: integer().notNull(),
    state: jsonb().$type<DeckWorkspaceState>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('deck_workspaces_revision_check', sql`${t.revision} > 0`),
    check('deck_workspaces_state_check', sql`jsonb_typeof(${t.state}) = 'object'`),
  ],
);
