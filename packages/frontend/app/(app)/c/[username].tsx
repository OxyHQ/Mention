import React from 'react';
import ProfileScreen from '@/components/ProfileScreen';

/**
 * ONE channel's page.
 *
 * A channel is an Oxy ACCOUNT, so its page is that account's profile and its
 * feed is that account's author feed — the same screen every other profile
 * renders, reached through a different URL. There is nothing bespoke here on
 * purpose: a second implementation of a profile is a second place for the
 * identity rules to drift.
 *
 * `/c/<handle>` stays distinct from `/@<handle>` because a channel is a
 * different kind of thing to follow, and the URL should say so. `ProfileScreen`
 * canonicalizes between the two off the resolved account's `kind`, so a person
 * cannot be sat on at `/c/` and a channel cannot be sat on at `/@`.
 *
 * The segment is named `[username]`, not `[handle]`, because that is what it
 * is: a channel account's handle IS its Oxy username, and the shared screen
 * reads exactly that param.
 */
export default function ChannelAccountRoute() {
    return <ProfileScreen tab="posts" />;
}
