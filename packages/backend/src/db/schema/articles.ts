/**
 * `articles` — the long-form body of a post. Ported from `models/Article.ts`.
 *
 * The linkage exists BOTH ways (`articles.post_id` and
 * `posts.content_article_id`), which could disagree. `articles.post_id` is
 * the owning side and the only one with a constraint; `posts.content_article_id`
 * stays as a denormalized read shortcut the hydrator already uses.
 */

import { sql } from 'drizzle-orm';
import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import { posts } from './posts';

/** `Article.title` length ceiling. */
export const ARTICLE_TITLE_MAX_LENGTH = 280;

export const articles = pgTable(
  'articles',
  {
    id: generatedId(),
    /**
     * NULLABLE and CASCADE: nullable because a draft article can exist before
     * its post, CASCADE because
     * `deletePost` already deletes it (`posts.controller.ts:1734`).
     */
    postId: text().references(() => posts.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    createdBy: text().notNull(),
    title: text(),
    body: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('articles_post_id_idx').on(t.postId).where(sql`${t.postId} is not null`),
    index('articles_created_by_idx').on(t.createdBy),
  ],
);
