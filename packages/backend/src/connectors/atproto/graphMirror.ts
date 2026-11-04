import { logger } from '../../utils/logger';
import { isDid, PUBLIC_APPVIEW } from './constants';
import { xrpcGet } from './xrpcClient';

/**
 * Read a Bluesky account's follows (`app.bsky.graph.getFollows`) or followers
 * (`app.bsky.graph.getFollowers`) from the public AppView as DIDs, for the remote
 * follow-graph mirror (`connectors/remoteGraphMirror.ts`).
 *
 * The atproto graph is public by protocol — there is no hidden collection — so
 * the only outcomes are the DIDs read (and whether the walk reached the end) or
 * a failed read, which concludes nothing. `complete: false` (the cap or the page
 * budget cut it short) stops the caller pruning edges it did not get to.
 */
export type AtprotoGraphRead =
  | { status: 'visible'; dids: string[]; complete: boolean }
  | { status: 'failed' };

interface AtprotoGraphPage {
  follows?: Array<{ did?: unknown }>;
  followers?: Array<{ did?: unknown }>;
  cursor?: string;
}

/** The AppView's own maximum page size for both queries. */
const GRAPH_PAGE_SIZE = 100;

export async function readAtprotoGraph(
  did: string,
  direction: 'follows' | 'followers',
  maxItems: number,
): Promise<AtprotoGraphRead> {
  const nsid =
    direction === 'follows' ? 'app.bsky.graph.getFollows' : 'app.bsky.graph.getFollowers';
  const dids = new Set<string>();
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    let page: AtprotoGraphPage;
    try {
      page = await xrpcGet<AtprotoGraphPage>(PUBLIC_APPVIEW, nsid, {
        actor: did,
        limit: GRAPH_PAGE_SIZE,
        cursor,
      });
    } catch (err) {
      logger.debug('[atproto] graph read failed', { nsid, error: String(err) });
      return { status: 'failed' };
    }
    const entries = direction === 'follows' ? page?.follows : page?.followers;
    // A page without the list is not an empty list: concluding "follows nobody"
    // from it would make a complete crawl prune every stored edge.
    if (!Array.isArray(entries)) {
      logger.debug('[atproto] graph read returned no list', { nsid });
      return { status: 'failed' };
    }
    for (const entry of entries) {
      if (dids.size >= maxItems) return { status: 'visible', dids: [...dids], complete: false };
      if (typeof entry?.did === 'string' && isDid(entry.did) && entry.did !== did)
        dids.add(entry.did);
    }
    cursor = typeof page?.cursor === 'string' && page.cursor ? page.cursor : undefined;
    // A cursor that comes back again, or a full set with pages left, ends the walk short.
    if (cursor && (seenCursors.has(cursor) || dids.size >= maxItems)) {
      return { status: 'visible', dids: [...dids], complete: false };
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return { status: 'visible', dids: [...dids], complete: true };
}
