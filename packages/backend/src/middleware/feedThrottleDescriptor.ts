// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import {
  isValidFeedDescriptor,
  parseFeedDescriptor,
  type FeedDescriptorSource,
} from '@mention/shared-types';
import type { Request } from 'express';
import { queryString } from '../utils/queryParams';

const EXPENSIVE_FEED_SOURCES: ReadonlySet<FeedDescriptorSource> = new Set(['for_you', 'explore']);

/**
 * Resolve the canonical source used by the MTN feed controller.
 *
 * The controller accepts only `descriptor`, so the throttle derives cost from
 * that same validated contract. A separate query parameter must never influence
 * rate classification for a request the controller itself will reject.
 */
export function getValidatedFeedSource(
  req: Pick<Request, 'query'>,
): FeedDescriptorSource | undefined {
  const descriptor = queryString(req.query.descriptor);
  return descriptor && isValidFeedDescriptor(descriptor)
    ? parseFeedDescriptor(descriptor).source
    : undefined;
}

export function isExpensiveFeedRequest(req: Pick<Request, 'query'>): boolean {
  const source = getValidatedFeedSource(req);
  return source !== undefined && EXPENSIVE_FEED_SOURCES.has(source);
}
