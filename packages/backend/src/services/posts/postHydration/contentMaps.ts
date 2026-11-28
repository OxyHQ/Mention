// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** Batched lookups keyed by post: polls, crossposts, imports, lanes, language variants, link cards and quote counts. */
import type { ClarityDocument } from '@mention/shared-types';
import type { LaneDisplayMode, LaneSummary } from '@mention/shared-types';
import { loadCrosspostVariants, type CrosspostVariantRow } from '../PostEquivalenceService';
import { asc, count, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../db/postgres';
import { pollOptions, pollVotes, polls as pollsTable } from '../../../db/schema/polls';
import { lanes as lanesTable } from '../../../db/schema/channels';
import { countQuotesOf } from '../../../db/posts/postRepository';
import {
  loadImportProvenance,
  type PostImportHydration,
} from '../../../db/imports/postImportRepository';
import { logger } from '../../../utils/logger';
import { resolveVariant, resolveViewerTag, type ResolvedVariant } from '../postVariants';
import {
  postPreviewableUrls,
  quotedPostUrlMatcher,
  quotedPostUrls,
  resolveClarityDocuments,
} from '../../../utils/clarityDocuments';
import {
  findPostLinkPreviews,
  type StoredLinkPreview,
} from '../../../db/posts/postLinkPreviewRepository';
import { linkPreviewKey } from '../../../connectors/shared/linkPreviews';
import type { StoredPostContent } from '@mention/shared-types';
import type { HydratedGraphNode, RawPost, ViewerContext } from './types';
import { extractReferenceIds, resolveId } from './graph';

/**
 * A federated post's own card for `url`, in the shape the app renders. Marked as
 * the remote server's (`id`), with no image: see `post_link_previews`.
 */
function remoteCardDocument(url: string, card: StoredLinkPreview): ClarityDocument {
  return {
    id: `remote-card:${url}`,
    canonicalUrl: url,
    requestedUrl: url,
    ...(card.title ? { title: card.title } : {}),
    ...(card.description ? { description: card.description } : {}),
    type: 'page',
    status: 'indexed',
    authors: [],
    evidence: {},
  };
}

/**
 * The link cards of a hydrated batch: each post's documents in text order, and
 * the posts with a link Clarity is still indexing (reported to the client as
 * `documentsPending`, so it can ask `POST /posts/documents` again).
 */
export interface ClarityDocumentMap {
  documents: Map<string, ClarityDocument[]>;
  pending: Set<string>;
}

export async function buildPollMap(
  nodes: HydratedGraphNode[],
  viewerId?: string,
): Promise<Map<string, Record<string, unknown>>> {
  const pollIds = Array.from(
    new Set(
      nodes
        .map(({ post }) => post?.content?.pollId)
        .filter(Boolean)
        .map((id) => String(id)),
    ),
  );

  if (pollIds.length === 0) {
    return new Map();
  }

  try {
    // Aggregate in Postgres: each option produces at most one summary row,
    // regardless of voter count. Only the current viewer's selection leaves
    // the database; other voters' identities never belong in a post DTO.
    const db = getDb();
    const [pollRows, optionRows, voteRows] = await Promise.all([
      db
        .select({ id: pollsTable.id, question: pollsTable.question, endsAt: pollsTable.endsAt })
        .from(pollsTable)
        .where(inArray(pollsTable.id, pollIds)),
      db
        .select({
          id: pollOptions.id,
          pollId: pollOptions.pollId,
          text: pollOptions.text,
          federatedVoteCount: pollOptions.federatedVoteCount,
        })
        .from(pollOptions)
        .where(inArray(pollOptions.pollId, pollIds))
        .orderBy(asc(pollOptions.pollId), asc(pollOptions.position)),
      db
        .select({
          pollId: pollVotes.pollId,
          optionId: pollVotes.optionId,
          voteCount: count(),
          viewerVoteCount: viewerId
            ? sql<number>`count(*) filter (where ${pollVotes.userId} = ${viewerId})`.mapWith(Number)
            : sql<number>`0`.mapWith(Number),
        })
        .from(pollVotes)
        .where(inArray(pollVotes.pollId, pollIds))
        .groupBy(pollVotes.pollId, pollVotes.optionId),
    ]);

    const optionsByPoll = new Map<string, typeof optionRows>();
    for (const option of optionRows) {
      const existing = optionsByPoll.get(option.pollId);
      if (existing) existing.push(option);
      else optionsByPoll.set(option.pollId, [option]);
    }

    const votesByOption = new Map(voteRows.map((row) => [row.optionId, row]));
    const map = new Map<string, Record<string, unknown>>();
    for (const poll of pollRows) {
      const options = optionsByPoll.get(poll.id) ?? [];
      const votes: Record<string, number> = {};
      const userVotes: Record<string, string> = {};
      for (const [index, option] of options.entries()) {
        const tally = votesByOption.get(option.id);
        // A federated poll's tally is its origin's (`poll_options.federated_vote_count`).
        votes[String(index)] =
          option.federatedVoteCount ?? (tally?.pollId === poll.id ? tally.voteCount : 0);
        if (viewerId && tally?.pollId === poll.id && tally.viewerVoteCount > 0) {
          userVotes[viewerId] = String(index);
        }
      }

      map.set(poll.id, {
        question: poll.question,
        options: options.map((option) => option.text),
        endTime: poll.endsAt.toISOString(),
        votes,
        userVotes,
      });
    }

    return map;
  } catch (error) {
    logger.error('[PostHydration] Failed to build poll map:', error);
    return new Map();
  }
}

/**
 * The lanes of every post in the graph, in ONE indexed query keyed by lane id.
 *
 * Emitting it on the summary is what propagates it to `originalPost` /
 * `quotedPost` / `boost.originalPost` for free: those are the SAME objects out
 * of `summaryMap`, so a quoted post shows its own lane without a second pass.
 *
 * `displayMode` travels with the name because it is what the chip's own menu
 * needs (an owner looking at their own post can see, and change, whether that
 * lane shows on the profile) — it is public curation state, not a permission.
 *
 * Fail-soft: a lookup failure yields an empty map, so the post renders without
 * a chip rather than not rendering at all.
 */
/**
 * Cross-post provenance for the batch, or an empty map when no post in it
 * could possibly have any.
 *
 * A cluster only ever holds federated variants — `detectCrosspostEquivalence`
 * requires two posts whose authoring actors sit on a reviewed pair of
 * NETWORKS, which a native Mention post has none of — so a batch with no
 * `federation.activityId` anywhere cannot contain a member, and asking is a
 * round trip that can only ever answer "no".
 */
export async function buildCrosspostMap(
  nodes: HydratedGraphNode[],
  postIds: string[],
): Promise<Map<string, CrosspostVariantRow[]>> {
  const anyFederated = nodes.some(({ post }) => Boolean(post?.federation?.activityId));
  if (!anyFederated) return new Map();
  return loadCrosspostVariants(postIds);
}

/**
 * Import provenance for the page, or an empty map when no post in it could
 * have any.
 *
 * An imported post is a NATIVE post of a local author, so a page of federated
 * posts cannot contain one and skips the query. Otherwise it is ONE statement
 * over the `post_imports` primary key for the whole page, never one per post.
 * Fail-open: provenance is decoration, so a failed read renders the page
 * without it rather than failing it.
 */
export async function buildImportMap(
  nodes: HydratedGraphNode[],
): Promise<Map<string, PostImportHydration>> {
  const candidateIds = nodes
    .filter(({ post }) => post && post.oxyUserId && !post.federation?.activityId)
    .map(({ post }) => resolveId(post))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (candidateIds.length === 0) return new Map();
  try {
    return await loadImportProvenance(candidateIds);
  } catch (error) {
    logger.error('[PostHydration] Failed to build import provenance map:', error);
    return new Map();
  }
}

export async function buildLaneMap(nodes: HydratedGraphNode[]): Promise<Map<string, LaneSummary>> {
  const laneIds = Array.from(
    new Set(
      nodes
        .map(({ post }) => post?.laneId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );

  if (laneIds.length === 0) {
    return new Map();
  }

  try {
    const rows = await getDb()
      .select({
        id: lanesTable.id,
        name: lanesTable.name,
        displayMode: lanesTable.displayMode,
      })
      .from(lanesTable)
      .where(inArray(lanesTable.id, laneIds));

    const map = new Map<string, LaneSummary>();
    for (const lane of rows) {
      map.set(lane.id, {
        id: lane.id,
        name: lane.name,
        displayMode: lane.displayMode as LaneDisplayMode,
      });
    }
    return map;
  } catch (error) {
    logger.error('[PostHydration] Failed to build lane map:', error);
    return new Map();
  }
}

/**
 * Resolve, for every post in the graph, the ONE localized rendition this viewer
 * is served — walking the ladder (explicit `?lang` → `Accept-Language` → the
 * viewer's Oxy account locales → the post's primary) and applying variant
 * inheritance. Pure and synchronous: {@link resolveViewerTag} and
 * {@link resolveVariant} read only the post's own content.
 */
export function buildResolvedVariantMap(
  nodes: HydratedGraphNode[],
  viewerContext: ViewerContext,
): Map<string, ResolvedVariant> {
  const resolvedMap = new Map<string, ResolvedVariant>();
  for (const { post } of nodes) {
    const postId = resolveId(post);
    if (!postId) continue;
    const content: StoredPostContent = post?.content ?? {};
    const tag = resolveViewerTag(viewerContext.languageCandidates, content);
    resolvedMap.set(postId, resolveVariant(content, tag));
  }
  return resolvedMap;
}

/**
 * Build the per-post link-preview map for a batch of posts. Each post maps to
 * its preview cards in {@link postPreviewableUrls} order — a federated `Page`'s
 * subject link first, then the body's links IN TEXT ORDER, capped at
 * `MAX_POST_DOCUMENTS` — so a post with several links renders a card per link. The
 * URLs are read from the RESOLVED body, so a reader served the Spanish variant
 * gets the cards for the links that variant actually contains.
 *
 * Documents come from Clarity, through {@link resolveClarityDocuments}: one
 * batch call over the DEDUPED url set, so posts sharing a URL cost one
 * resolution. Clarity owns fetching, caching and image hosting; `imageUrl` and
 * `faviconUrl` are served as Clarity returns them.
 *
 * No `waitMs`: a hydrated read answers with what Clarity already has. Asking
 * it to wait up to 2s held every page carrying
 * a not-yet-resolved link for the whole wait — about 2s of each production
 * `/search` in issue #1140. Stored posts are warmed at ingest
 * (`postEnrichment/clarityDocumentStep`) and at creation
 * (`warmClarityDocumentForText`), so most links are already indexed by the
 * time anyone reads them.
 *
 * A link Clarity has NOT finished (a post seen for the first time — a remote
 * profile's older posts, say) has no document yet. Rather than answer as if the
 * post had no card, the post is marked pending, and the app asks
 * `POST /posts/documents` for it a few seconds later. A link Clarity gave up on
 * (`failed`, `blocked`, `removed`) gets no card and is not pending.
 *
 * A URL naming a profile on THIS instance gets no card (see
 * {@link previewableUrls}), because the reader is not shown a link there: the
 * linkifier renders that span as a mention.
 */
export async function buildClarityDocumentMap(
  nodes: HydratedGraphNode[],
  resolvedMap: Map<string, ResolvedVariant>,
): Promise<ClarityDocumentMap> {
  const result: ClarityDocumentMap = { documents: new Map(), pending: new Set() };

  const postToUrls = new Map<string, string[]>(); // postId -> [url] (text order)
  const uniqueUrls = new Set<string>();

  const postsById = new Map<string, RawPost>();
  for (const { post } of nodes) {
    const id = resolveId(post);
    if (id) postsById.set(id, post);
  }

  for (const { post } of nodes) {
    const postId = resolveId(post);
    if (!postId) continue;

    const text = resolvedMap.get(postId)?.text;
    // A link to the quoted post is that post's embed, not a card of its own.
    const quotedId = extractReferenceIds({ quoteOf: post.quoteOf })[0];
    const urls = postPreviewableUrls(
      post.content,
      typeof text === 'string' ? text : undefined,
      quotedPostUrlMatcher(quotedPostUrls(quotedId ? postsById.get(quotedId) : undefined)),
    );
    if (urls.length === 0) continue;

    postToUrls.set(postId, urls);
    for (const url of urls) uniqueUrls.add(url);
  }

  if (uniqueUrls.size === 0) return result;

  const resolved = await resolveClarityDocuments([...uniqueUrls]);

  // The card a federated post ARRIVED with (FEP-8967) stands in for a link
  // Clarity has no document for — pending, or given up on — so the reader sees
  // the author's server's card instead of none. Read only for those posts, and
  // only ever applied to the post that carried it.
  const uncovered = [...postToUrls].filter(([, urls]) =>
    urls.some((url) => !resolved.documents.has(url)),
  );
  const remoteCards =
    uncovered.length > 0
      ? await findPostLinkPreviews(uncovered.map(([postId]) => postId)).catch(
          () => new Map<string, StoredLinkPreview[]>(),
        )
      : new Map<string, StoredLinkPreview[]>();

  for (const [postId, urls] of postToUrls) {
    const cards = new Map<string, StoredLinkPreview>();
    for (const card of remoteCards.get(postId) ?? []) {
      const key = linkPreviewKey(card.url);
      if (key) cards.set(key, card);
    }
    const documents: ClarityDocument[] = [];
    for (const url of urls) {
      const document = resolved.documents.get(url);
      if (document) {
        // Bind the document to this post's source URL, even when Clarity
        // originally fetched the same article through another alias.
        documents.push({ ...document, requestedUrl: url });
        continue;
      }
      const key = linkPreviewKey(url);
      const card = key ? cards.get(key) : undefined;
      if (card) documents.push(remoteCardDocument(url, card));
      else if (resolved.pending.has(url)) result.pending.add(postId);
    }
    if (documents.length > 0) result.documents.set(postId, documents);
  }

  return result;
}

/**
 * Posts-that-quote counts for the whole hydrated graph in ONE indexed
 * aggregate over `{ quoteOf: 1, createdAt: -1 }`. Only ids with at least one
 * quote appear; a caller reads a miss as zero. Counting on read (rather than a
 * denormalized `stats.quotesCount`) matches how the insights endpoint already
 * reports quotes, so there is one source of truth and nothing to backfill or
 * keep in lockstep at the quote write sites.
 */
export async function buildQuoteCountMap(postIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (postIds.length === 0) return counts;

  for (const [postId, count] of await countQuotesOf(postIds)) {
    counts.set(postId, count);
  }
  return counts;
}
