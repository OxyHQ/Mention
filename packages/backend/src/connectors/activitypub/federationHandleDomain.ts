/**
 * Fediverse handles on a separate domain: `@user@mention.org` while every
 * ActivityPub actor and object id stays on `https://mention.earth`
 * (docs/mention-org-domain-move.md, Phase 3). It is Mastodon's
 * `LOCAL_DOMAIN`/`WEB_DOMAIN` split, applied to an instance that already has
 * federated history, so no follow, post, like or boost moves: remote servers
 * re-verify the handle through WebFinger and rename the account they already
 * hold.
 *
 * OFF BY DEFAULT. `FEDERATION_HANDLE_DOMAIN` defaults to `FEDERATION_DOMAIN`, and
 * `FEDERATION_HANDLE_DOMAIN_ACCOUNTS` to nobody, so every account answers exactly
 * as before until both are set. The list is the gradual rollout (a QA account
 * first, then `all`).
 *
 * This module is the ONE decision "is this account's handle on the handle
 * domain?". The WebFinger answer (`webfingerHandleDomain.ts`), the actor's
 * FEP-2c59 `webfinger` property (`actorObject.ts`), the `@user@domain` labels
 * Mention writes into federated content and the `Update(Person)` announcement
 * (`scripts/announceFederationHandles.ts`) all read it, so they cannot disagree.
 * It is a pure function of the username and the configuration: no I/O, so it
 * cannot fail open on an outage.
 *
 * The instance actor never switches: it is not a person, Mastodon verifies it on
 * every signed fetch, and moving its handle buys nothing.
 */
import {
  INSTANCE_ACTOR_USERNAME,
  isSameFederationHost,
  normalizeActorUsername,
  type LocalActorBuilder,
} from '@oxy.so/federation';
import { ALL_HANDLE_DOMAIN_ACCOUNTS, config } from '../../config';

/** Which local accounts have switched: every one, or the named usernames. */
export type HandleDomainAccounts = typeof ALL_HANDLE_DOMAIN_ACCOUNTS | readonly string[];

/** The resolved handle-domain configuration. */
export interface FederationHandlePolicy {
  /** `FEDERATION_DOMAIN`: actor ids, inboxes, keys, and every handle that has not switched. */
  readonly federationDomain: string;
  /** `FEDERATION_HANDLE_DOMAIN`: the domain of a switched account's handle. */
  readonly handleDomain: string;
  /** Normalized usernames, or `all`. */
  readonly accounts: typeof ALL_HANDLE_DOMAIN_ACCOUNTS | ReadonlySet<string>;
}

/** Build a policy. Usernames are normalized the way the WebFinger engine normalizes them. */
export function createFederationHandlePolicy(input: {
  federationDomain: string;
  handleDomain?: string | null;
  accounts?: HandleDomainAccounts | null;
}): FederationHandlePolicy {
  const accounts = input.accounts ?? [];
  return {
    federationDomain: input.federationDomain,
    handleDomain: input.handleDomain || input.federationDomain,
    accounts:
      accounts === ALL_HANDLE_DOMAIN_ACCOUNTS
        ? ALL_HANDLE_DOMAIN_ACCOUNTS
        : new Set(accounts.map(normalizeActorUsername).filter(Boolean)),
  };
}

/** Whether the policy can switch anybody at all: a distinct handle domain and a non-empty rollout. */
export function isHandlePolicyActive(policy: FederationHandlePolicy): boolean {
  if (isSameFederationHost(policy.handleDomain, policy.federationDomain)) return false;
  return policy.accounts === ALL_HANDLE_DOMAIN_ACCOUNTS || policy.accounts.size > 0;
}

/** Whether `username`'s fediverse handle is on the handle domain. */
export function isHandleSwitched(policy: FederationHandlePolicy, username: string): boolean {
  if (!isHandlePolicyActive(policy)) return false;
  const name = normalizeActorUsername(username);
  if (!name || name === INSTANCE_ACTOR_USERNAME) return false;
  return policy.accounts === ALL_HANDLE_DOMAIN_ACCOUNTS || policy.accounts.has(name);
}

/** The domain of `username`'s fediverse handle: the handle domain when switched, else the federation domain. */
export function handleDomainFor(policy: FederationHandlePolicy, username: string): string {
  return isHandleSwitched(policy, username) ? policy.handleDomain : policy.federationDomain;
}

/**
 * A local account's acct, `<username>@<domain>`, with no `acct:` and no leading
 * `@`. The username is kept as given, so an unswitched account's label is the
 * string Mention wrote before this existed.
 */
export function localAcct(policy: FederationHandlePolicy, username: string): string {
  return `${username}@${handleDomainFor(policy, username)}`;
}

/**
 * The FEP-2c59 `webfinger` value of a switched actor, `<username>@<handle domain>`
 * (the form Mastodon emits and reads: no `acct:`, no `@`), or `undefined` when
 * the account has not switched.
 */
export function actorWebfingerProperty(
  policy: FederationHandlePolicy,
  username: string,
): string | undefined {
  if (!isHandleSwitched(policy, username)) return undefined;
  return `${normalizeActorUsername(username)}@${policy.handleDomain}`;
}

/**
 * The actor document with FEP-2c59 `webfinger` for a switched account, placed
 * after `preferredUsername`. An unswitched account gets the SAME object back,
 * untouched. Nothing else changes: `id`, inbox, keys, `preferredUsername`,
 * `alsoKnownAs` and `url` stay as the engine built them. `url` stays on purpose:
 * Mastodon drops an actor `url` whose host is not the actor id's host
 * (`ProcessAccountService#mismatching_origin?`), so a mention.org `url` would be
 * shown as the bare actor id instead.
 *
 * No JSON-LD term is added: Mastodon (4.6 fetch, 4.7+ fetch and `Update`) reads
 * the compacted key `webfinger` directly, and the shared `@context` belongs to
 * `@oxy.so/federation` (an upstream change, see the PR).
 */
export function withActorWebfinger(
  actor: Record<string, unknown>,
  username: string,
  policy: FederationHandlePolicy,
): Record<string, unknown> {
  const webfinger = actorWebfingerProperty(policy, username);
  if (webfinger === undefined) return actor;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(actor)) {
    if (key === 'webfinger') continue;
    result[key] = value;
    if (key === 'preferredUsername') result.webfinger = webfinger;
  }
  if (!('webfinger' in result)) result.webfinger = webfinger;
  return result;
}

/**
 * Bind {@link withActorWebfinger} around an actor builder. The GET actor route and
 * the `Update(Person)` broadcast share the one builder, so both carry the property.
 */
export function withFederationHandleBuilder(
  builder: LocalActorBuilder,
  policy: FederationHandlePolicy,
): LocalActorBuilder {
  if (!isHandlePolicyActive(policy)) return builder;
  return (params) => withActorWebfinger(builder(params), params.username, policy);
}

/** The process's policy, from `FEDERATION_HANDLE_DOMAIN` and `FEDERATION_HANDLE_DOMAIN_ACCOUNTS`. */
export const federationHandlePolicy: FederationHandlePolicy = createFederationHandlePolicy({
  federationDomain: config.federation.domain,
  handleDomain: config.federation.handleDomain,
  accounts: config.federation.handleDomainAccounts,
});
