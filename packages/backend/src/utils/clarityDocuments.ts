import type { ClarityDocument } from '@mention/shared-types';
import { ownProfileUrlHandle } from '@mention/shared-types/profileUrls';

import { config } from '../config';
import { getClarityClient } from './clarityClient';
import { extractUrls } from './extractUrls';
import { logger } from './logger';

/**
 * The one place Mention turns a body's links into Clarity documents. Every
 * surface that shows a link card reads through here: post hydration, the
 * pending-documents follow-up (`POST /posts/documents`) and the composer
 * (`POST /posts/link-previews`). The app never talks to Clarity itself; it asks this
 * backend, which calls Clarity with the service's own credentials.
 */

/**
 * The hosts whose `/@alice` URLs name a user in OUR namespace.
 *
 * These must be the same hosts the app recognises
 * (`packages/frontend/utils/ownProfileLinks.ts`, which derives its list from the
 * app's `WEB_BASE_URL` and is shared by the reader's linkifier and the composer's
 * mention summary), because the decisions are halves of one behaviour: the
 * renderer turns such a URL into a mention, and {@link previewableUrls} withholds
 * the preview card that would otherwise sit under it. If the lists disagree the
 * reader sees the mismatch — a mention with a redundant card, or a link that lost
 * its card for no visible reason.
 *
 * The federation domain rather than `FRONTEND_URL`: they agree in production,
 * but `FRONTEND_URL` is a CORS origin and is `http://localhost:8110` in
 * development, where the app's own base URL is not. `ACTOR_DOMAIN` defaults to
 * the same value and is only distinct when actor URIs are served elsewhere. Read
 * from `config` (the same values `connectors/activitypub/constants` exports) so a
 * link-card helper does not reach into the ActivityPub connector.
 */
const OWN_PROFILE_HOSTS: readonly string[] = [
  ...new Set(
    [config.federation.domain, config.federation.actorDomain].filter((host): host is string =>
      Boolean(host),
    ),
  ),
];

/**
 * True when a URL names a profile on this instance — the URLs the reader is
 * shown a MENTION for rather than a link.
 *
 * The same `ownProfileUrlHandle` the linkifier decides with, so the two cannot
 * drift into disagreeing about a URL. Purely syntactic, so this costs a `URL`
 * parse per extracted link and no I/O.
 */
export function isOwnProfileLink(url: string): boolean {
  return ownProfileUrlHandle(url, OWN_PROFILE_HOSTS) !== undefined;
}

/**
 * The links in a body that get a card, in text order.
 *
 * {@link extractUrls} applies the `MAX_POST_DOCUMENTS` cap BEFORE the profile
 * filter, so a body carrying more than that many links, one of which is a profile
 * link, renders one card fewer instead of promoting the next link into the freed
 * slot. Moving the filter ahead of the cap would mean teaching a generally-named
 * URL extractor about profile links, which is a worse trade for a case that needs
 * five links in one body to reach.
 */
export function previewableUrls(text: string): string[] {
  return extractUrls(text).filter((url) => !isOwnProfileLink(url));
}

/**
 * Clarity statuses that mean "still working on it": asking again later can
 * produce a document. `blocked`, `failed` and `removed` are final, so a URL in
 * one of those states is never reported as pending and nobody retries it.
 */
const IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  // Admission is temporary; keep warming this URL when crawl capacity frees.
  'throttled',
  'discovered',
  'fetching',
  'extracted',
]);

export interface ResolvedClarityDocuments {
  /** Requested URL → its document, for every URL Clarity has one for. */
  documents: Map<string, ClarityDocument>;
  /** Requested URLs Clarity is still indexing, with no document yet. */
  pending: Set<string>;
}

/**
 * A document with only the images Clarity itself serves.
 *
 * A reader's device must never load a link card's image or favicon from the
 * linked site: that tells the site who read what, and loads whatever it chooses
 * to serve. Clarity hands out its own copies (`/images/...`, `/favicons/...` on
 * its API origin), so any image URL on another origin is dropped here rather
 * than passed on — the card shows without that image instead of hotlinking it.
 * This is the one door every card goes through (hydration, the pending-card
 * follow-up and the composer), so no other code path can leak an origin URL.
 */
export function clarityHostedDocument(document: ClarityDocument): ClarityDocument {
  const { imageUrl, faviconUrl, ...rest } = document;
  return {
    ...rest,
    ...(isClarityAssetUrl(imageUrl) ? { imageUrl } : {}),
    ...(isClarityAssetUrl(faviconUrl) ? { faviconUrl } : {}),
  };
}

function isClarityAssetUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).origin === new URL(config.clarityApiUrl).origin;
  } catch {
    return false;
  }
}

/**
 * The most URLs Clarity's `POST /v1/resolve` accepts in one call; a larger body
 * is a 400 for the whole batch (`urlsSchema` in Clarity's `search-platform.ts`).
 */
export const CLARITY_RESOLVE_BATCH = 50;

/**
 * Resolve a deduped URL set against Clarity, in calls of at most
 * {@link CLARITY_RESOLVE_BATCH} URLs run side by side. Without the split, a page
 * carrying more than 50 distinct links lost EVERY card on it to one 400.
 *
 * `waitMs` is how long Clarity may hold the call open for URLs it has not
 * finished. Feed and detail reads omit it and answer with what Clarity already
 * has (issue #1140), so a first-seen URL comes back pending. Only callers off the
 * render path pass one.
 *
 * Results are matched to the URLs we sent BY POSITION: Clarity answers one result
 * per requested URL, in request order, but echoes each URL canonicalised (fragment
 * dropped, host lower-cased, a bare origin given its `/`), so matching on
 * `resolution.url` silently dropped the card of any link it rewrote.
 *
 * Never throws. When a call fails (Clarity unreachable, or its crawl quota
 * exhausted — a 429) its URLs are reported pending: the failure is transient,
 * and a later ask can still produce the card.
 */
export async function resolveClarityDocuments(
  urls: readonly string[],
  options: { waitMs?: number } = {},
): Promise<ResolvedClarityDocuments> {
  const documents = new Map<string, ClarityDocument>();
  const pending = new Set<string>();
  const unique = [...new Set(urls)];
  if (unique.length === 0) return { documents, pending };

  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += CLARITY_RESOLVE_BATCH) {
    batches.push(unique.slice(start, start + CLARITY_RESOLVE_BATCH));
  }

  let client: Awaited<ReturnType<typeof getClarityClient>>;
  try {
    client = await getClarityClient();
  } catch (error) {
    logger.warn('[ClarityDocuments] Clarity client unavailable', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    for (const url of unique) pending.add(url);
    return { documents, pending };
  }
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const response = await client.indexing.resolve({
          urls: batch,
          ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
        });
        batch.forEach((url, index) => {
          const resolution = response.data[index];
          if (resolution?.document) {
            documents.set(url, clarityHostedDocument(resolution.document));
          } else if (!resolution || IN_PROGRESS_STATUSES.has(resolution.status)) {
            pending.add(url);
          }
        });
      } catch (error) {
        logger.warn('[ClarityDocuments] Failed to resolve documents from Clarity', {
          count: batch.length,
          reason: error instanceof Error ? error.message : 'unknown',
        });
        for (const url of batch) pending.add(url);
      }
    }),
  );

  return { documents, pending };
}
