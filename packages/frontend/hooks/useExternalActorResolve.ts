import { useMemo } from 'react';
import { useDebouncedValue } from '@oxy.so/bloom/hooks';
import { useQuery } from '@tanstack/react-query';
import { normalizeFederatedAcct } from '@mention/shared-types/federation';
import { stripAtprotoHandlePrefix } from '@mention/shared-types/handle';
import { feedService, type ExternalActorResolution } from '@/services/feedService';
import { looksLikeRemoteHandle } from '@/utils/externalActor';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';

/** Debounce window before a remote-handle query hits `GET /federation/resolve`. */
const RESOLVE_DEBOUNCE_MS = 400;

/**
 * How long a successful resolution stays fresh (handle → actor is stable). A miss
 * is never fresh: the account may be discovered a moment later — by this search's
 * own people results, a profile view, another tab — and the next look at the same
 * handle must ask again rather than repeat "nobody" for five minutes.
 */
const RESOLVE_STALE_TIME = 5 * 60 * 1000;
const RESOLVE_GC_TIME = 30 * 60 * 1000;

/**
 * Resolve a raw search query to a cross-network external actor (Mastodon /
 * Bluesky), or `null` when there is none.
 *
 * Debounces the query, and only calls `GET /federation/resolve` when the
 * debounced value LOOKS like a remote handle (`@user@host`, `user.bsky.social`,
 * `did:…`, `at://…`) or a pasted profile link (`https://x.com/elonmusk`) — a bare
 * local `@username` never triggers a resolve and stays entirely on the Oxy people
 * search. Resolution and caching are owned by React Query.
 *
 * The lookup is a non-blocking ENRICHMENT of the normal people results: the
 * resolved actor is merged into them as one more row, and every non-result — a
 * 404 miss, an unreachable instance, a network error — is the same quiet `null`.
 * The search screen never waits on it and never reports it.
 */
export function useExternalActorResolve(rawQuery: string): ExternalActorResolution | null {
  // The search box updates on every keystroke; resolve once typing settles.
  const debounced = useDebouncedValue(rawQuery.trim(), RESOLVE_DEBOUNCE_MS);

  const isRemoteQuery = useMemo(() => looksLikeRemoteHandle(debounced), [debounced]);
  // One spelling per account, so `@Alice@Host` and `alice@host` share one cache
  // entry and send one identical request.
  // `@alice.bsky.social` and `alice.bsky.social` likewise.
  const handle = normalizeFederatedAcct(debounced) ?? stripAtprotoHandlePrefix(debounced);

  const { data } = useQuery<ExternalActorResolution | null>({
    queryKey: publicQueryKeys.externalActorResolve(handle),
    // React Query aborts only after the last observer leaves this query.
    queryFn: ({ signal }) => feedService.resolveExternalActor(handle, signal),
    enabled: isRemoteQuery,
    staleTime: (query) => (query.state.data ? RESOLVE_STALE_TIME : 0),
    gcTime: RESOLVE_GC_TIME,
    retry: 1,
  });

  return isRemoteQuery ? (data ?? null) : null;
}
