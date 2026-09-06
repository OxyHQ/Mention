import React from 'react';

import ComposeScreen from '@/components/Compose/ComposeScreen';

/**
 * `/compose` — the composer as a DESTINATION.
 *
 * This is the route fourteen call sites push, almost always with params: a
 * reply (`?replyToPostId=`), an edit (`?editPostId=`), a quote, and the OS
 * share sheet through `lib/shareIntent.native.ts`. It sits ABOVE the tabs in
 * the stack, so Back returns the reader to the post or profile they opened it
 * from — which a tab cannot do, and which is why the composer is served by two
 * routes rather than one. `(tabs)/write.tsx` is the other.
 */
export default function ComposeRoute() {
  return <ComposeScreen presentation="pushed" />;
}
