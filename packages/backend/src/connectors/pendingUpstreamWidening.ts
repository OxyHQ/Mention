/**
 * ⚠ PENDING UPSTREAM — delete the widening in this file when Mention bumps to
 * `@oxy.so/contracts` 4.0.0 and the matching `@oxy.so/federation` release.
 *
 * The ONE module that knows the published packages (`@oxy.so/contracts` 3.0.0,
 * `@oxy.so/federation` 2.1.2) do not yet name the `instagram-graph` protocol: an
 * Instagram account Oxy resolved through Meta's Graph API because no ActivityPub
 * bridge answered for it. Oxy returns it as
 * `externalIdentity.protocol = 'instagram-graph'`,
 * `actorUri = 'instagram-graph:<ig-user-id>'`.
 *
 * Two gaps, both closed here and nowhere else:
 *
 *  1. TYPES — `NetworkId` is `'activitypub' | 'atproto'`, so a connector with id
 *     `'instagram-graph'` cannot be a `NetworkConnector`. The widened aliases
 *     below are structurally the upstream ones plus the third id; the
 *     ActivityPub and atproto connectors satisfy them unchanged.
 *  2. RUNTIME — contracts 3.0.0 validates `protocol` with a zod enum, so a
 *     response carrying `'instagram-graph'` would THROW in `resolveOxyIdentity`
 *     and `lookupOxyIdentities` — including the reconciliation lookups of a
 *     person who merely HAS an Instagram Graph identity next to others. The
 *     parsers below mask that one value, run the published schema UNCHANGED
 *     (every other check and every refinement still applies), and restore it.
 *     The contracts schema runs on its own zod 3 instance, so it cannot be
 *     extended with this package's zod 4 — hence mask-and-restore rather than a
 *     re-declared schema that could drift from the reviewed one.
 *
 * AFTER THE BUMP, this file's body becomes re-exports:
 *
 *   export type { NetworkId, NormalizedExternalActor, NormalizedExternalPost,
 *     FetchPostsResult, NetworkConnector } from '@oxy.so/federation';
 *   export const parseResolveExternalIdentityResponse =
 *     (raw: unknown) => resolveExternalIdentityResponseSchema.parse(raw);
 *   export const parseLookupExternalIdentitiesResponse =
 *     (raw: unknown) => lookupExternalIdentitiesResponseSchema.parse(raw);
 *
 * and nothing that imports from here changes.
 */

import type * as Federation from '@oxy.so/federation';
import {
  lookupExternalIdentitiesResponseSchema,
  resolveExternalIdentityResponseSchema,
} from '@oxy.so/contracts';

/** The protocol id Oxy uses for a Graph-API-resolved Instagram account. */
export const INSTAGRAM_GRAPH_NETWORK_ID = 'instagram-graph' as const;

/** Every protocol an Oxy external identity can name. */
export type ExternalIdentityProtocol = 'activitypub' | 'atproto' | typeof INSTAGRAM_GRAPH_NETWORK_ID;

// ── @oxy.so/federation ──────────────────────────────────────────────────────

export type NetworkId = Federation.NetworkId | typeof INSTAGRAM_GRAPH_NETWORK_ID;

export type NormalizedExternalActor = Omit<Federation.NormalizedExternalActor, 'network'> & { network: NetworkId };

export type NormalizedExternalPost = Omit<Federation.NormalizedExternalPost, 'network'> & { network: NetworkId };

export interface FetchPostsResult {
  posts: NormalizedExternalPost[];
  cursor?: string;
}

/**
 * `@oxy.so/federation`'s `NetworkConnector` with the widened id and actor/post
 * shapes. Methods keep METHOD syntax so the upstream connectors (narrower
 * `network`) remain assignable.
 */
export interface NetworkConnector<TContent = unknown>
  extends Omit<Federation.NetworkConnector<TContent>, 'id' | 'resolve' | 'fetchProfile' | 'fetchPosts' | 'mapIdentity'> {
  readonly id: NetworkId;
  resolve(handle: string): Promise<NormalizedExternalActor | null>;
  fetchProfile(externalId: string): Promise<NormalizedExternalActor | null>;
  fetchPosts(externalId: string, opts?: Federation.FetchPostsOptions): Promise<FetchPostsResult>;
  mapIdentity(actor: NormalizedExternalActor): Promise<string | null>;
}

// ── @oxy.so/contracts ───────────────────────────────────────────────────────

type ContractResolved = ReturnType<typeof resolveExternalIdentityResponseSchema.parse>;

/**
 * `Omit` that keeps the KNOWN keys of a type with an index signature. The
 * contract's user schema passes unknown keys through, and a plain `Omit` over
 * `{ [k: string]: unknown; id: string; … }` collapses every property to
 * `unknown`; key remapping preserves them.
 */
type OmitKnown<T, K extends PropertyKey> = { [P in keyof T as P extends K ? never : P]: T[P] };
type ContractReference = ContractResolved['externalIdentities'][number];
type ContractLookup = ReturnType<typeof lookupExternalIdentitiesResponseSchema.parse>;

export type ExternalIdentityReference = OmitKnown<ContractReference, 'protocol'> & { protocol: ExternalIdentityProtocol };

export type ResolvedExternalIdentity = OmitKnown<ContractResolved, 'user' | 'externalIdentity' | 'externalIdentities'> & {
  user: OmitKnown<ContractResolved['user'], 'externalIdentities'> & { externalIdentities: ExternalIdentityReference[] };
  externalIdentity: ExternalIdentityReference & { userId: string };
  externalIdentities: ExternalIdentityReference[];
};

export type LookedUpExternalIdentity = OmitKnown<ContractLookup['identities'][number], 'externalIdentities'> & {
  externalIdentities: ExternalIdentityReference[];
};

/** A value the published enum accepts, standing in for the one it does not yet. */
const MASK_PROTOCOL = 'activitypub';

type Path = ReadonlyArray<string | number>;

/**
 * Deep-copy `raw`, replacing every `protocol: 'instagram-graph'` with the mask
 * and recording where. Only the `protocol` KEY is touched — a value elsewhere
 * that happens to read `instagram-graph` is left for the schema to judge.
 */
function maskInstagramGraphProtocol(raw: unknown, path: Path = [], found: Path[] = []): { value: unknown; found: Path[] } {
  if (Array.isArray(raw)) {
    return { value: raw.map((item, index) => maskInstagramGraphProtocol(item, [...path, index], found).value), found };
  }
  if (raw !== null && typeof raw === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'protocol' && value === INSTAGRAM_GRAPH_NETWORK_ID) {
        found.push([...path, key]);
        out[key] = MASK_PROTOCOL;
      } else {
        out[key] = maskInstagramGraphProtocol(value, [...path, key], found).value;
      }
    }
    return { value: out, found };
  }
  return { value: raw, found };
}

/**
 * Put the real protocol back on the PARSED output. Zod preserves object and
 * array positions for every path it keeps, so the recorded path addresses the
 * same reference; a path the schema stripped (an unknown key) is skipped.
 */
function restoreInstagramGraphProtocol(parsed: unknown, found: readonly Path[]): void {
  for (const path of found) {
    let node: unknown = parsed;
    for (const segment of path.slice(0, -1)) {
      if (node === null || typeof node !== 'object') { node = undefined; break; }
      node = (node as Record<string | number, unknown>)[segment];
    }
    if (node !== null && typeof node === 'object' && (node as Record<string, unknown>).protocol === MASK_PROTOCOL) {
      (node as Record<string, unknown>).protocol = INSTAGRAM_GRAPH_NETWORK_ID;
    }
  }
}

/** `resolveExternalIdentityResponseSchema.parse`, accepting the `instagram-graph` protocol. */
export function parseResolveExternalIdentityResponse(raw: unknown): ResolvedExternalIdentity {
  const { value, found } = maskInstagramGraphProtocol(raw);
  const parsed = resolveExternalIdentityResponseSchema.parse(value);
  restoreInstagramGraphProtocol(parsed, found);
  return parsed as ResolvedExternalIdentity;
}

/** `lookupExternalIdentitiesResponseSchema.parse`, accepting the `instagram-graph` protocol. */
export function parseLookupExternalIdentitiesResponse(raw: unknown): { identities: LookedUpExternalIdentity[] } {
  const { value, found } = maskInstagramGraphProtocol(raw);
  const parsed = lookupExternalIdentitiesResponseSchema.parse(value);
  restoreInstagramGraphProtocol(parsed, found);
  return parsed as { identities: LookedUpExternalIdentity[] };
}
