import { createLogger } from '@oxy.so/core/logger';
import { api } from '@/utils/api';
import { normalizeApiError } from '@/utils/apiError';

const logger = createLogger('PrivacyService');

/**
 * Tell Mention's backend that the viewer's Oxy privacy lists just changed.
 *
 * Blocks and restrictions belong to Oxy and the app writes them there directly;
 * Mention only READS them, and holds each viewer's lists for a short freshness
 * window so the feed does not re-ask Oxy on every request. That window is the
 * only thing between a block the app just wrote and the feed acting on it, so
 * the client says when it wrote one instead of waiting the window out. The
 * endpoint takes no body and drops the AUTHENTICATED caller's entry, nobody
 * else's.
 *
 * Best-effort by construction: the write to Oxy has already succeeded by the
 * time this runs, and the freshness window expires on its own within seconds —
 * so a failure here delays convergence and must never fail the block flow or
 * reach the user.
 */
export async function refreshPrivacyLists(): Promise<void> {
  try {
    await api.post('/privacy/refresh');
  } catch (error) {
    logger.warn('Privacy cache refresh failed; the feed converges when the window expires', {
      ...normalizeApiError(error),
    });
  }
}
