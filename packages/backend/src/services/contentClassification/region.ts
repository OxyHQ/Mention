/**
 * Best-effort region derivation for the Stage-A baseline classifier.
 *
 * Region is deliberately weak and nullable. It is derived ONLY from external
 * signals we actually have — a federated instance domain (host or TLD) or an
 * explicit author locale — NEVER inferred from post text. Returns `undefined`
 * whenever no high-confidence signal is present.
 */

import { INSTANCE_REGION_MAP, TLD_REGION_MAP } from './taxonomy';

/** Length of an ISO 3166-1 alpha-2 region code. */
const ISO_3166_1_ALPHA2_LENGTH = 2;

/**
 * Extracts a region code from an explicit locale string (e.g. `"es-ES"` →
 * `"ES"`, `"pt-BR"` → `"BR"`). Returns `undefined` when the locale has no
 * 2-letter region subtag.
 */
function regionFromLocale(locale: string | undefined): string | undefined {
  if (!locale) return undefined;
  const parts = locale.trim().split('-');
  if (parts.length < 2) return undefined;
  const region = parts[1].toUpperCase();
  if (region.length !== ISO_3166_1_ALPHA2_LENGTH) return undefined;
  if (!/^[A-Z]{2}$/.test(region)) return undefined;
  return region;
}

/**
 * Extracts a region from a federated instance domain. Two passes:
 *   1. exact full-host match against the curated instance map, then
 *   2. the host's last label (TLD) against the ccTLD map.
 *
 * A map entry whose value is the empty string means "known but intentionally
 * global / no region" → returns `undefined` (and short-circuits the TLD pass so
 * a global instance on a ccTLD is not mislabeled).
 */
function regionFromInstance(instanceDomain: string | undefined): string | undefined {
  if (!instanceDomain) return undefined;
  const host = instanceDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (host.length === 0) return undefined;

  if (Object.prototype.hasOwnProperty.call(INSTANCE_REGION_MAP, host)) {
    const mapped = INSTANCE_REGION_MAP[host];
    return mapped.length > 0 ? mapped : undefined;
  }

  const labels = host.split('.');
  const tld = labels[labels.length - 1];
  const mappedTld = TLD_REGION_MAP[tld];
  return mappedTld ?? undefined;
}

/**
 * Resolves a best-effort coarse region from the available external signals.
 * Precedence: federated instance domain (strongest external signal we have) →
 * author locale → `undefined`.
 */
export function deriveRegion(params: {
  isFederated?: boolean;
  instanceDomain?: string;
  authorLocale?: string;
}): string | undefined {
  if (params.isFederated) {
    const fromInstance = regionFromInstance(params.instanceDomain);
    if (fromInstance) return fromInstance;
  }
  return regionFromLocale(params.authorLocale);
}
