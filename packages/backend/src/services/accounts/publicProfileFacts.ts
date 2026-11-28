// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { RemoteProfileStats } from '@mention/shared-types/profile';
import { countAuthorPublicPosts, type AuthorPostCounts } from '../../db/posts/authorPostCounts';
import { loadRemoteProfileStats } from '../federation/remoteProfileStats';

/** What Mention itself knows about an account, beyond its Oxy profile. */
export interface PublicProfileFacts {
  counts: AuthorPostCounts;
  /**
   * Present only for a federated account: the origin's own totals and join
   * date, each omitted when unknown. See `remoteProfileStats`.
   */
  remote?: RemoteProfileStats;
}

/**
 * The account's public post counts and, for a federated account, its origin's
 * figures — read together, by the profile page's stats and by the profile's
 * structured data, so a reader and a search engine are told the same numbers.
 */
export async function loadPublicProfileFacts(oxyUserId: string): Promise<PublicProfileFacts> {
  // Side by side rather than one after the other; a local account has no
  // actor row and gets no `remote` block.
  const [counts, remote] = await Promise.all([
    countAuthorPublicPosts(oxyUserId),
    loadRemoteProfileStats(oxyUserId),
  ]);
  return { counts, ...(remote ? { remote } : {}) };
}
