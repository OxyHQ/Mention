import {
  isValidFeedDescriptor,
  parseFeedDescriptor,
  type FeedDescriptorSource,
} from '@mention/shared-types';
import type { Request } from 'express';
import { queryString } from '../utils/queryParams';

const EXPENSIVE_FEED_SOURCES: ReadonlySet<FeedDescriptorSource> = new Set([
  'for_you',
  'explore',
]);

/**
 * Resolve the canonical source used by the MTN feed controller.
 *
 * The current API sends `descriptor`; `type` is accepted only as a legacy
 * fallback when no descriptor parameter was supplied. If descriptor is present
 * but malformed, never consult `type`: the controller will reject that request,
 * and the throttle must not classify it using a conflicting attacker-controlled
 * parameter.
 */
export function getValidatedFeedSource(req: Pick<Request, 'query'>): FeedDescriptorSource | undefined {
  if (Object.prototype.hasOwnProperty.call(req.query, 'descriptor')) {
    const descriptor = queryString(req.query.descriptor);
    return descriptor && isValidFeedDescriptor(descriptor)
      ? parseFeedDescriptor(descriptor).source
      : undefined;
  }

  const legacyType = queryString(req.query.type);
  return legacyType && isValidFeedDescriptor(legacyType)
    ? parseFeedDescriptor(legacyType).source
    : undefined;
}

export function isExpensiveFeedRequest(req: Pick<Request, 'query'>): boolean {
  const source = getValidatedFeedSource(req);
  return source !== undefined && EXPENSIVE_FEED_SOURCES.has(source);
}
