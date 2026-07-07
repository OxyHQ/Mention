import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { feedService, type ExternalActorResolution } from '@/services/feedService';
import { looksLikeRemoteHandle } from '@/utils/externalActor';

/** Debounce window before a remote-handle query hits `GET /federation/resolve`. */
const RESOLVE_DEBOUNCE_MS = 400;

/** How long a successful resolution stays fresh (handle → actor is stable). */
const RESOLVE_STALE_TIME = 5 * 60 * 1000;
const RESOLVE_GC_TIME = 30 * 60 * 1000;

export interface UseExternalActorResolveResult {
  /** The resolved external actor, or null when the query resolves to nothing. */
  actor: ExternalActorResolution | null;
  /** True while a resolve request for a remote-looking query is in flight. */
  loading: boolean;
  /** True when the resolve request failed (network/server error, not a 404 miss). */
  error: boolean;
  /** Whether the (debounced) query looks like a remote handle worth resolving. */
  isRemoteQuery: boolean;
  /** Re-run the resolve (used by the search UI's error-retry affordance). */
  retry: () => void;
}

/**
 * Resolve a raw search query to a cross-network external actor.
 *
 * Debounces the query, and only calls `GET /federation/resolve` when the
 * debounced value LOOKS like a remote handle (`@user@host`, `user.bsky.social`,
 * `did:…`, `at://…`) — a bare local `@username` never triggers a resolve and
 * stays entirely on the existing Oxy people search. Resolution, loading, error
 * and caching are owned by React Query.
 *
 * A 404 miss ("not an external handle" / actor not found) surfaces as
 * `actor: null` with `error: false`, so the UI simply shows no external card.
 */
export function useExternalActorResolve(rawQuery: string): UseExternalActorResolveResult {
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

  const query = useQuery<ExternalActorResolution | null>({
    queryKey: ['federation', 'resolve', debounced],
    queryFn: () => feedService.resolveExternalActor(debounced),
    enabled: isRemoteQuery,
    staleTime: RESOLVE_STALE_TIME,
    gcTime: RESOLVE_GC_TIME,
    retry: 1,
  });

  return {
    actor: isRemoteQuery ? query.data ?? null : null,
    loading: isRemoteQuery && query.isPending && query.fetchStatus !== 'idle',
    error: isRemoteQuery && query.isError,
    isRemoteQuery,
    retry: () => {
      void query.refetch();
    },
  };
}
