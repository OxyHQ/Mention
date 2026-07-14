import React from 'react';
import type { FeedInterstitialSlot } from '@mention/shared-types';
import { SimilarAccountsInterstitial } from './SimilarAccountsInterstitial';
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
  /**
   * The descriptor of the feed this card sits in. Every event the card reports is
   * attributed to it, so a card's performance can be read per feed. Absent when a
   * card is rendered outside a real feed — nothing is reported then.
   */
  feedDescriptor?: string;
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
  feedDescriptor,
}: FeedInterstitialProps): React.ReactElement | null {
  switch (slot.kind) {
    case 'suggestedUsers':
      return (
        <SuggestedUsersInterstitial
          ordinal={ordinal}
          slotKey={slot.key}
          feedDescriptor={feedDescriptor}
        />
      );
    case 'suggestedFeeds':
      return (
        <SuggestedFeedsInterstitial
          ordinal={ordinal}
          slotKey={slot.key}
          feedDescriptor={feedDescriptor}
        />
      );
    case 'suggestedStarterPacks':
      return (
        <SuggestedStarterPacksInterstitial
          ordinal={ordinal}
          slotKey={slot.key}
          feedDescriptor={feedDescriptor}
        />
      );
    case 'similarAccounts':
      return (
        <SimilarAccountsInterstitial
          ordinal={ordinal}
          slotKey={slot.key}
          feedDescriptor={feedDescriptor}
          subjectId={slot.subjectId}
        />
      );
  }
}
