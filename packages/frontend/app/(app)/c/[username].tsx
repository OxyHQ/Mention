import React from 'react';
import ChannelScreen from '@/components/ChannelScreen';

/**
 * ONE channel's page.
 *
 * A channel is an Oxy ACCOUNT, so its page is that account's profile and its
 * feed is that account's author feed — but it is NOT the same screen a person
 * gets. `ChannelScreen` composes the shared profile primitives (the account
 * lookup, the chrome, the body, the canonicalization) with what a channel
 * actually is: four tabs, a compact header, no banner, no poke, and the
 * operator's way in to its settings.
 *
 * `/c/<handle>` stays distinct from `/@<handle>` because a channel is a
 * different kind of thing to follow, and the URL should say so. Both screens
 * canonicalize through the SAME `canonicalProfileHref`, so a person cannot be
 * sat on at `/c/` and a channel cannot be sat on at `/@` — and neither screen
 * can disagree with the other about which way to send a reader.
 *
 * The segment is named `[username]`, not `[handle]`, because that is what it
 * is: a channel account's handle IS its Oxy username.
 */
export default function ChannelAccountRoute() {
    return <ChannelScreen />;
}
