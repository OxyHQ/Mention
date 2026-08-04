import React from 'react';
import { AccountInfoScreen } from '@/components/AccountInfoScreen';

/**
 * A PERSON's about page.
 *
 * The screen itself is shared with `/c/<handle>/about` — what an account is
 * reads the same whoever it belongs to. Only the URL family differs, and it is
 * declared here rather than sniffed, so the shared screen can canonicalize a
 * reader who arrived on the wrong one.
 */
export default function ProfileAboutRoute() {
    return <AccountInfoScreen routedFamily="person" />;
}
