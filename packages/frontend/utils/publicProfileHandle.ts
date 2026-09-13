import { externalIdentityReferenceSchema } from '@oxy.so/contracts';

function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').trim().toLowerCase();
}

/**
 * Public routes may name the canonical Oxy username or an Oxy-proven network
 * alias. Transport accts only address source delivery and never grant a route.
 * The shared contract validates alias metadata; Mention derives no identities.
 */
export function isPublicProfileHandle(
  routedHandle: string,
  resolvedUsername: string | null | undefined,
  resolvedProfile?: unknown,
): boolean {
  const canonical = typeof resolvedUsername === 'string' ? normalizeHandle(resolvedUsername) : '';
  if (!canonical) return false;
  const routed = normalizeHandle(routedHandle);
  if (routed === canonical) return true;
  if (!resolvedProfile || typeof resolvedProfile !== 'object' || !('externalIdentities' in resolvedProfile)) return false;
  const aliases = externalIdentityReferenceSchema.array().safeParse(resolvedProfile.externalIdentities);
  return aliases.success && aliases.data.some((alias) => normalizeHandle(alias.canonicalAcct) === routed);
}
