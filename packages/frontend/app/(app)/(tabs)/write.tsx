import React from 'react';

import ComposeScreen from '@/components/Compose/ComposeScreen';

/**
 * `/write` — the composer as a PLACE, one of the five root tabs.
 *
 * Always blank on arrival (bar the reader's own persisted draft), and it stays
 * mounted, so swiping away mid-sentence and swiping back returns to the
 * sentence. It reads no params: every composer opened WITH an intent — a reply,
 * a quote, an edit, a share — is a push to `/compose`, which is a separate
 * instance sitting above the tabs. `components/Compose/ComposeScreen.tsx`
 * documents why the two must not be the same mount.
 *
 * A second URL for one screen is the price of the composer being both a tab and
 * a dismissible destination. The alternative was one route serving both, which
 * cannot work: `/compose` and `(tabs)/compose` resolve to the SAME path (a group
 * adds no segment), and folding the pushed opens into the tab would mean Back
 * from a reply leaving the reader on whichever tab they were last on instead of
 * the post they were replying to.
 */
export default function WriteTab() {
  return <ComposeScreen presentation="tab" />;
}
