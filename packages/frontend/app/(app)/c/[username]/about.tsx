import React from 'react';
import { AccountInfoScreen } from '@/components/AccountInfoScreen';

/**
 * A CHANNEL's about page.
 *
 * A channel has one of these for the same reason a person does: it is an Oxy
 * account with a joined date, a handle, a website and a place on the fediverse,
 * and its profile links here from the "Joined <date>" row. What it must NOT use
 * is `/@<handle>/about` — that route belongs to the person family, and a channel
 * sitting on it is a URL the account does not own.
 */
export default function ChannelAboutRoute() {
    return <AccountInfoScreen routedFamily="channel" />;
}
