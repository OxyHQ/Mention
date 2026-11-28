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
