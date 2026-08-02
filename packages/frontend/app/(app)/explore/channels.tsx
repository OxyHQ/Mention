import React from 'react';
import { ChannelsTab } from '@/components/ChannelsTab';

/**
 * Explore › Channels (route `/explore/channels`) — the channel directory,
 * most-followed first, so channels are discoverable from Explore rather than
 * only from a byline, the composer's picker, or `/channels` typed by hand.
 */
export default function ExploreChannelsScreen() {
  return <ChannelsTab />;
}
