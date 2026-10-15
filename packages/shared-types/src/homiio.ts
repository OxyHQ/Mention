import { caseIdSchema, getHomiioCaseUrl, parseHomiioCaseUrl } from '@oxy.so/homiio-contracts';
import { scanTextEntities, toOpenableUrl, trimUrlTrailingPunctuation } from './textEntities';

export { getHomiioCaseUrl, parseHomiioCaseUrl };

/** The only Homiio data Mention owns. Provider facts never enter a post or draft. */
export interface HomiioCaseReference {
  caseId: string;
}

/** Project untrusted input to the reference, discarding any supplied metadata. */
export function sanitizeHomiioCase(value: unknown): HomiioCaseReference | undefined {
  if (!value || typeof value !== 'object' || !('caseId' in value)) return undefined;
  const parsed = caseIdSchema.safeParse(value.caseId);
  return parsed.success ? { caseId: parsed.data } : undefined;
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
