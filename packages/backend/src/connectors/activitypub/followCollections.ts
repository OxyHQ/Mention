import { isAbsoluteHttpUrl } from '../shared/url';
import { isBlockedDomain } from './constants';
import {
  activityPubItems,
  activityPubLinkUrl,
  asRecord,
  fetchActivityPubObjectAs,
} from './helpers';

/**
 * Read an actor's `following` or `followers` collection as a list of actor URIs,
 * for the remote follow-graph mirror (`connectors/remoteGraphMirror.ts`).
 *
 * The origin's privacy answer is the first thing read and is final:
 *
 * - `hidden` — the collection is refused (401/403), gone (404/410), or states a
 *   total but serves neither items nor a first page. That last one is Mastodon's
 *   "hide your social graph": the root keeps `totalItems` (the profile still shows
 *   the count) and every page is withheld. The mirror then shows and keeps nothing.
 * - `failed` — the read could not complete for a reason that says nothing about
 *   the account's choice (timeout, 5xx, a malformed page). Nothing is concluded.
 * - `visible` — the URIs read, and whether the walk reached the end. A walk cut
 *   short by `maxItems` or the page budget is `complete: false`, which is what
 *   stops the caller pruning edges it simply did not get to.
 *
 * Pages are followed only on the collection's own origin, signed as the
 * instance, and a URI on a blocked domain (or one of ours) is dropped.
 */
export type FollowCollectionRead =
  | { status: 'visible'; uris: string[]; complete: boolean; totalItems?: number }
  | { status: 'hidden' }
  | { status: 'failed' };

export interface FollowCollectionOptions {
  /** Stop after this many URIs (the walk is then incomplete). 0 reads the root alone. */
  maxItems: number;
  /** Stop after this many page fetches beyond the root. */
  maxPages: number;
}

function itemUri(item: unknown): string | null {
  const uri = activityPubLinkUrl(item);
  if (!uri || !isAbsoluteHttpUrl(uri)) return null;
  try {
    return isBlockedDomain(new URL(uri).hostname.toLowerCase()) ? null : uri;
  } catch {
    return null;
  }
}

function sameOriginAs(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export async function readFollowCollection(
  collectionUrl: string | undefined,
  options: FollowCollectionOptions,
): Promise<FollowCollectionRead> {
  if (!collectionUrl || !isAbsoluteHttpUrl(collectionUrl)) return { status: 'hidden' };
  const origin = new URL(collectionUrl).origin;

  const root = await fetchActivityPubObjectAs(collectionUrl);
  if (root.kind !== 'object') return { status: root.kind === 'failed' ? 'failed' : 'hidden' };

  const collection = root.object;
  const totalItems = typeof collection.totalItems === 'number' ? collection.totalItems : undefined;
  const inlineFirst = asRecord(collection.first);
  const firstUrl = inlineFirst ? null : activityPubLinkUrl(collection.first);
  const inlineItems = activityPubItems(collection);
  if (inlineItems.length === 0 && !inlineFirst && !firstUrl) {
    // An empty collection is visible; a non-empty one that serves nothing is hidden.
    return totalItems === 0 || (totalItems === undefined && Array.isArray(collection.orderedItems))
      ? { status: 'visible', uris: [], complete: true, totalItems }
      : { status: 'hidden' };
  }

  const uris = new Set<string>();
  const take = (items: unknown[]): boolean => {
    for (const item of items) {
      if (uris.size >= options.maxItems) return false;
      const uri = itemUri(item);
      if (uri) uris.add(uri);
    }
    return true;
  };

  // `maxItems: 0` reads the root alone: visibility and the stated total.
  let room = options.maxItems > 0 && take(inlineItems);
  let next: string | null = null;
  if (inlineFirst) {
    room = room && take(activityPubItems(inlineFirst));
    next = activityPubLinkUrl(inlineFirst.next);
  } else if (inlineItems.length === 0) {
    next = firstUrl;
  }

  let pages = 0;
  const visited = new Set<string>();
  while (room && next) {
    if (pages >= options.maxPages || visited.has(next) || !sameOriginAs(next, origin)) {
      return { status: 'visible', uris: [...uris], complete: false, totalItems };
    }
    visited.add(next);
    pages += 1;
    const page = await fetchActivityPubObjectAs(next);
    // A root that answered and a page that refuses is the same privacy choice.
    if (page.kind === 'refused') return { status: 'hidden' };
    if (page.kind !== 'object') return { status: 'failed' };
    room = take(activityPubItems(page.object));
    next = activityPubLinkUrl(page.object.next);
  }
  return { status: 'visible', uris: [...uris], complete: room && !next, totalItems };
}
