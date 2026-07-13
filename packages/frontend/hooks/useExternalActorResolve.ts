import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { feedService, type ExternalActorResolution } from '@/services/feedService';
import { looksLikeRemoteHandle } from '@/utils/externalActor';

/** Debounce window before a remote-handle query hits `GET /federation/resolve`. */
const RESOLVE_DEBOUNCE_MS = 400;

/** How long a successful resolution stays fresh (handle → actor is stable). */
const RESOLVE_STALE_TIME = 5 * 60 * 1000;
const RESOLVE_GC_TIME = 30 * 60 * 1000;

/**
 * Resolve a raw search query to a cross-network external actor (Mastodon /
 * Bluesky), or `null` when there is none.
 *
 * Debounces the query, and only calls `GET /federation/resolve` when the
 * debounced value LOOKS like a remote handle (`@user@host`, `user.bsky.social`,
 * `did:…`, `at://…`) — a bare local `@username` never triggers a resolve and
 * stays entirely on the Oxy people search. Resolution and caching are owned by
 * React Query.
 *
 * The lookup is a non-blocking ENRICHMENT of the normal people results: the
 * resolved actor is merged into them as one more row, and every non-result — a
 * 404 miss, an unreachable instance, a network error — is the same quiet `null`.
 * The search screen never waits on it and never reports it.
 */
export function useExternalActorResolve(rawQuery: string): ExternalActorResolution | null {
  // Value-debounce the raw query: the search box updates on every keystroke, but
  // we only want to resolve once typing settles. This is the idiomatic place for
  // an effect — subscribing to a changing input and a timer.
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const trimmed = rawQuery.trim();
    const timeoutId = setTimeout(() => setDebounced(trimmed), RESOLVE_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [rawQuery]);

  const isRemoteQuery = useMemo(() => looksLikeRemoteHandle(debounced), [debounced]);

  const { data } = useQuery<ExternalActorResolution | null>({
    queryKey: ['federation', 'resolve', debounced],
    queryFn: () => feedService.resolveExternalActor(debounced),
    enabled: isRemoteQuery,
    staleTime: RESOLVE_STALE_TIME,
    gcTime: RESOLVE_GC_TIME,
    retry: 1,
  });

  return isRemoteQuery ? data ?? null : null;
}
