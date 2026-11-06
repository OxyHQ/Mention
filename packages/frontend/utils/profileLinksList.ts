import type { ProfileLink } from '@oxy.so/core';
import type { RemoteProfileField } from '@mention/shared-types/profile';
import { extractUrls } from './extractUrls';
import { mergeBioAndProfileLinks } from './mergeBioAndProfileLinks';
import { prettifyUrl } from './prettifyUrl';

/**
 * The links a profile shows as pills. A profile's links come from three places:
 * its own link list and bio (Oxy accounts), and a remote profile's metadata
 * fields. A field whose value is a link (Bluesky writes its YouTube, podcast or
 * website links this way) is a link, titled by the field's name; the rest of
 * the fields stay metadata rows.
 */

/** The first URL in a remote field's value, or `null` for a plain-text field. */
function fieldUrl(field: RemoteProfileField): string | null {
  return extractUrls(field.value)[0] ?? null;
}

/** Remote fields that are links, as pill links, in field order. */
function fieldLinks(fields: readonly RemoteProfileField[] | undefined): ProfileLink[] {
  const out: ProfileLink[] = [];
  (fields ?? []).forEach((field, index) => {
    const url = fieldUrl(field);
    if (url) out.push({ id: `field-${index}`, url, title: field.name });
  });
  return out;
}

/** Every link the profile shows as a pill, deduplicated by address. */
export function profileLinksList(input: {
  linksMetadata?: Parameters<typeof mergeBioAndProfileLinks>[0];
  links?: string[];
  bio?: string;
  fields?: RemoteProfileField[];
}): ProfileLink[] {
  const seen = new Set<string>();
  const out: ProfileLink[] = [];
  for (const link of [
    ...mergeBioAndProfileLinks(input.linksMetadata, input.links, input.bio),
    ...fieldLinks(input.fields),
  ]) {
    const key = prettifyUrl(link.url).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

/** The remote fields that are not links: the metadata rows the profile still shows. */
export function nonLinkFields(
  fields: readonly RemoteProfileField[] | undefined,
): RemoteProfileField[] | undefined {
  return fields?.filter((field) => fieldUrl(field) === null);
}
