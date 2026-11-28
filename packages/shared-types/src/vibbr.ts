// `@vibbr.co/sdk/links` is the SDK's schema-free half: this module is on the
// feed's and composer's startup path, so it must not pull the schema runtime in.
import { getEventUrl, isEventId, parseEventUrl } from '@vibbr.co/sdk/links';
import { scanTextEntities, toOpenableUrl, trimUrlTrailingPunctuation } from './textEntities';

export { getEventUrl, parseEventUrl };

/** The only Vibbr data Mention owns. Event facts never enter a post or draft. */
export interface VibbrEventReference {
  eventId: string;
}

/** Project untrusted input to the reference, discarding any supplied metadata. */
export function sanitizeVibbrEvent(value: unknown): VibbrEventReference | undefined {
  if (!value || typeof value !== 'object' || !('eventId' in value)) return undefined;
  const { eventId } = value;
  return typeof eventId === 'string' && isEventId(eventId) ? { eventId } : undefined;
}

/** One attachment per post; parsing uses the same URL scanner as the composer. */
export function vibbrEventFromText(text: string): VibbrEventReference | undefined {
  for (const entity of scanTextEntities(text, { kinds: ['url'] })) {
    const { url } = trimUrlTrailingPunctuation(entity.value);
    const eventId = parseEventUrl(toOpenableUrl(url));
    if (eventId !== null) return { eventId };
  }
  return undefined;
}
