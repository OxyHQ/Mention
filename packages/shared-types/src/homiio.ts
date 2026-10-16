// The `links` entry is Homiio's Zod-free half: this module is on the feed's and
// composer's startup path, so it must not pull the schema runtime in.
import {
  CASE_ID_MAX_LENGTH,
  CASE_ID_MIN_LENGTH,
  getHomiioCaseUrl,
  parseHomiioCaseUrl,
} from '@oxy.so/homiio-contracts/links';
import { scanTextEntities, toOpenableUrl, trimUrlTrailingPunctuation } from './textEntities';

export { getHomiioCaseUrl, parseHomiioCaseUrl };

/** The only Homiio data Mention owns. Provider facts never enter a post or draft. */
export interface HomiioCaseReference {
  caseId: string;
}

/** Project untrusted input to the reference, discarding any supplied metadata. */
export function sanitizeHomiioCase(value: unknown): HomiioCaseReference | undefined {
  if (!value || typeof value !== 'object' || !('caseId' in value)) return undefined;
  const { caseId } = value;
  return typeof caseId === 'string' &&
    caseId.length >= CASE_ID_MIN_LENGTH &&
    caseId.length <= CASE_ID_MAX_LENGTH
    ? { caseId }
    : undefined;
}

/** One attachment per post; parsing uses the same URL scanner as the composer. */
export function homiioCaseFromText(text: string): HomiioCaseReference | undefined {
  for (const entity of scanTextEntities(text, { kinds: ['url'] })) {
    const { url } = trimUrlTrailingPunctuation(entity.value);
    const caseId = parseHomiioCaseUrl(toOpenableUrl(url));
    if (caseId !== null) return { caseId };
  }
  return undefined;
}
