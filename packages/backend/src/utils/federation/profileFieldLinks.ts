/**
 * A remote profile field whose value is a link: a URL, or an anchor to one.
 *
 * Such a field is a profile link, and the link lives on the account Oxy holds
 * for the remote actor, with the native links. Mention keeps only the fields
 * that carry no link as the profile's metadata rows. This is the one definition
 * of "a link field", and it matches the one Oxy applies when it reads the same
 * field (`fieldLink` in oxy's external identity policy).
 */
export function isLinkField(value: string): boolean {
  if (httpsUrl(value.trim())) return true;
  for (const match of value.matchAll(/<a\b[^>]*>/gi)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[0]);
    if (href && httpsUrl((href[1] ?? href[2] ?? '').trim())) return true;
  }
  return false;
}

function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * A remote profile field that names the account's pronouns. Oxy holds them as the
 * account's structured pronoun (the closed list), so the field is not kept again
 * as a metadata row. Matches the name rule Oxy applies (`pronounsFromFields` in
 * oxy's external identity policy).
 */
export function isPronounField(name: string): boolean {
  const normalized = name
    .replace(/[\s:]+$/, '')
    .trim()
    .toLowerCase();
  return normalized === 'pronouns' || normalized === 'pronoun';
}
