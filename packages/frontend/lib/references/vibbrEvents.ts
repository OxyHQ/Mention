import type { EventCard } from '@vibbr.co/sdk';
import { VisibleReferenceStore } from './VisibleReferenceStore';

/**
 * No provider fetch or SDK initialization runs during feed hydration or import.
 * The SDK checks its answers with a structural guard, not zod, so cards add no
 * second way for zod into the app (see `lib/notificationValidation`).
 */
export const vibbrEvents = new VisibleReferenceStore<EventCard>(async (ids, options) => {
  const { VibbrClient } = await import('@vibbr.co/sdk');
  const items = await new VibbrClient().getEventCards(ids, { signal: options.signal });
  const found = new Set(items.map((card) => card.id));
  return { items, unavailableIds: ids.filter((id) => !found.has(id)) };
});
