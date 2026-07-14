import React from 'react';
import type { FeedInterstitialSlot } from '@mention/shared-types';
import { SuggestedFeedsInterstitial } from './SuggestedFeedsInterstitial';
import { SuggestedStarterPacksInterstitial } from './SuggestedStarterPacksInterstitial';
import { SuggestedUsersInterstitial } from './SuggestedUsersInterstitial';

interface FeedInterstitialProps {
  /** The PLACEMENT the server planned: which kind of card, anchored where. */
  slot: FeedInterstitialSlot;
  /**
   * Which interstitial this is within the accumulated feed (0, 1, 2…). Each band
   * offsets into its suggestion pool by its ordinal, so a viewer who scrolls past
   * two "who to follow" cards is not shown the same accounts twice.
   */
  ordinal: number;
}

/**
 * A recommendation card in the feed — the client half of the server's slot plan.
 *
 * The server sends only the KIND and the POSITION; the content is fetched here,
 * lazily, from the recommendation endpoints the rest of the app already caches,
 * so a feed response never waits on a suggestion. Each band decides for itself
 * whether it has enough to say: too few suggestions and it renders NOTHING,
 * because an empty band is a worse interruption than no band at all.
 */
export default function FeedInterstitial({
  slot,
  ordinal,
}: FeedInterstitialProps): React.ReactElement | null {
  switch (slot.kind) {
    case 'suggestedUsers':
      return <SuggestedUsersInterstitial ordinal={ordinal} />;
    case 'suggestedFeeds':
      return <SuggestedFeedsInterstitial ordinal={ordinal} />;
    case 'suggestedStarterPacks':
      return <SuggestedStarterPacksInterstitial ordinal={ordinal} />;
  }
}
