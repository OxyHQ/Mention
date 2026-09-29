import { useState } from 'react';

/**
 * True until the feed first presents: its leading element has settled
 * (`leadingPending`) AND its first page is ready. Until then the feed shows only
 * its loading state — no leading element — so neither can land on top of the
 * other; after that it latches and never holds again (a refresh keeps both on
 * screen). See `leadingPending` in `Feed.web.tsx`.
 */
export function useHoldForLeading(leadingPending: boolean | undefined, firstPageReady: boolean): boolean {
    const [released, setReleased] = useState(!leadingPending && firstPageReady);
    if (!released && !leadingPending && firstPageReady) setReleased(true);
    return !released;
}
