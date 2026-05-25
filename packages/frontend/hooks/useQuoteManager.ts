import { useCallback, useEffect, useRef, useState } from 'react';

import { logger } from '@/lib/logger';
import { feedService } from '@/services/feedService';
import type { HydratedPost } from '@mention/shared-types';

import { buildQuoteFallbackUrl } from '@/utils/composeIntent';

export interface QuoteManagerState {
  /** The hydrated quoted post (when fetch succeeded). */
  post: HydratedPost | null;
  /** Whether a fetch is currently in flight. */
  loading: boolean;
  /** A user-facing error, or null when no error. */
  error: string | null;
  /**
   * Set when the post fetch fails (404, private, network) so the compose
   * screen can append a fallback URL to the text instead of rendering a card.
   */
  fallbackUrl: string | null;
  /** The id currently tracked by this manager, or null when nothing is set. */
  quotePostId: string | null;
}

export interface UseQuoteManagerResult extends QuoteManagerState {
  /** Begin tracking a quoted post by id. Triggers a fetch. */
  setQuotePostId: (id: string | null) => void;
  /** Clear the quoted post (e.g. user dismissed the preview). */
  clearQuote: () => void;
}

const INITIAL_STATE: QuoteManagerState = {
  post: null,
  loading: false,
  error: null,
  fallbackUrl: null,
  quotePostId: null,
};

/**
 * Minimum-shape type guard for the `/feed/item/:id` and `/posts/:id` responses.
 * The endpoint returns `any` so we narrow defensively before storing it.
 */
const isHydratedPost = (value: unknown): value is HydratedPost => {
  if (!value || typeof value !== 'object') return false;
  const post = value as { id?: unknown };
  return typeof post.id === 'string' && post.id.length > 0;
};

/**
 * Mirrors the parent-post fetch pattern in `compose.tsx` (lines 462-486) but
 * exposes a fallback URL on failure so the composer can degrade gracefully:
 *  - On success → renders `<QuoteCard>`.
 *  - On 404 / private / network error → caller appends `fallbackUrl` to text.
 */
export const useQuoteManager = (): UseQuoteManagerResult => {
  const [state, setState] = useState<QuoteManagerState>(INITIAL_STATE);
  // Track the id we're currently fetching to ignore stale responses.
  const inflightIdRef = useRef<string | null>(null);

  const setQuotePostId = useCallback((id: string | null) => {
    if (!id) {
      inflightIdRef.current = null;
      setState(INITIAL_STATE);
      return;
    }
    inflightIdRef.current = id;
    setState({
      post: null,
      loading: true,
      error: null,
      fallbackUrl: null,
      quotePostId: id,
    });
  }, []);

  const clearQuote = useCallback(() => {
    inflightIdRef.current = null;
    setState(INITIAL_STATE);
  }, []);

  useEffect(() => {
    const id = state.quotePostId;
    if (!id || !state.loading) return;

    let cancelled = false;
    (async () => {
      try {
        const raw: unknown = await feedService.getPostById(id);
        if (cancelled || inflightIdRef.current !== id) return;
        // `getPostById` returns `any`; narrow to the minimum shape we need
        // before we treat the response as a HydratedPost.
        const post = isHydratedPost(raw) ? raw : null;
        if (post) {
          setState({
            post,
            loading: false,
            error: null,
            fallbackUrl: null,
            quotePostId: id,
          });
        } else {
          setState({
            post: null,
            loading: false,
            error: 'not_found',
            fallbackUrl: buildQuoteFallbackUrl(id),
            quotePostId: id,
          });
        }
      } catch (err) {
        if (cancelled || inflightIdRef.current !== id) return;
        logger.warn('useQuoteManager: failed to load quoted post', {
          quotePostId: id,
          error: err instanceof Error ? err.message : String(err),
        });
        setState({
          post: null,
          loading: false,
          error: err instanceof Error ? err.message : 'fetch_failed',
          fallbackUrl: buildQuoteFallbackUrl(id),
          quotePostId: id,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state.quotePostId, state.loading]);

  return {
    ...state,
    setQuotePostId,
    clearQuote,
  };
};
