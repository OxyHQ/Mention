/**
 * WebFinger for accounts whose fediverse handle is on the handle domain
 * (`FEDERATION_HANDLE_DOMAIN`, `federationHandleDomain.ts`).
 *
 * The shared engine router (`@oxy.so/federation/node` `createWebfingerRouter`)
 * knows one domain and answers `subject: acct:<user>@<FEDERATION_DOMAIN>`. For a
 * SWITCHED account this wrapper rewrites that answer on the way out, on every
 * host and for every resource form that names the account (`acct:u@<handle
 * domain>`, `acct:u@<federation domain>`, an alias host, or the actor URL):
 *
 *   subject  acct:u@<handle domain>
 *   aliases  [actor id, <web origin>/@u, acct:u@<federation domain>]
 *   links    `self` unchanged (the actor on the federation domain);
 *            profile-page on the web origin
 *
 * That is what Mastodon verifies: it asks for `acct:u@mention.earth` (the actor's
 * host), follows the subject to `acct:u@mention.org`, and accepts it when that
 * answer's `self` is the actor id it holds. The actor id never changes.
 *
 * WHAT CANNOT CHANGE:
 * - The engine still decides everything else: 404 for an unknown, hidden or
 *   private account, 410 for an erased one, 400 for a malformed resource, the
 *   instance actor. Only a 200 JRD whose subject and `self` are exactly the
 *   engine's for that username is rewritten; any other body passes through.
 * - The Redis JRD cache keeps holding the engine's own answer (the cache sits
 *   inside the engine, before this rewrite), so a switched and an unswitched
 *   answer can never be stored under one key, and changing the rollout list
 *   takes effect on the next request with nothing to evict.
 * - An unswitched account, and every account while the policy is inactive, gets
 *   the engine router itself: the same bytes as before this module existed.
 * - The decision is a pure function of the username and the configuration, so no
 *   outage can produce a switched answer for the wrong account.
 */
import { normalizeActorUsername, type UrlBuilders } from '@oxy.so/federation';
import type { WebfingerJrd } from '@oxy.so/federation/node';
import { type RequestHandler, Router } from 'express';
import {
  type FederationHandlePolicy,
  isHandlePolicyActive,
  isHandleSwitched,
} from './federationHandleDomain';
import { pinQuery } from './webfingerAliasDomains';

const ACCT_SCHEME = 'acct:';
export const PROFILE_PAGE_REL = 'http://webfinger.net/rel/profile-page';

/** A local username as it can appear in an actor URL path segment. */
const ACTOR_PATH_USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** A JRD with the `aliases` a switched answer carries. */
export interface HandleDomainJrd extends WebfingerJrd {
  aliases?: string[];
}

export interface WebfingerHandleDomainOptions {
  policy: FederationHandlePolicy;
  /** The actor id builder, the same one the engine's `self` link uses. */
  urls: Pick<UrlBuilders, 'actor'>;
  /** The canonical web origin (`MENTION_WEB_ORIGIN`), with no trailing slash. */
  webOrigin: string;
}

/** What a request names: the local username, and the `acct:` resource to hand the engine instead. */
export interface WebfingerHandleTarget {
  username: string;
  rewrittenResource?: string;
}

/**
 * The username of an actor URL resource (`https://<actor domain>/ap/users/<u>`),
 * or `undefined` for anything else. The prefix is the builder's own output, so
 * the shape cannot drift from the ids the actor document carries.
 */
export function actorUrlUsername(
  resource: string,
  urls: Pick<UrlBuilders, 'actor'>,
): string | undefined {
  const prefix = urls.actor('');
  if (resource.length <= prefix.length) return undefined;
  if (resource.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return undefined;
  const segment = resource.slice(prefix.length);
  if (!ACTOR_PATH_USERNAME.test(segment)) return undefined;
  return normalizeActorUsername(segment);
}

/**
 * The switched account a WebFinger `resource` names, or `undefined` when it names
 * no switched account (the request then goes to the engine untouched). An `acct:`
 * resource is parsed exactly as the engine parses it (the local part before the
 * first `@`); its domain is left to the engine and the alias wrapper, which refuse
 * a domain that is not ours. An actor URL is rewritten to the federation domain's
 * `acct:`, the one form the engine reads.
 */
export function switchedWebfingerTarget(
  resource: unknown,
  { policy, urls }: Pick<WebfingerHandleDomainOptions, 'policy' | 'urls'>,
): WebfingerHandleTarget | undefined {
  if (typeof resource !== 'string') return undefined;
  if (resource.startsWith(ACCT_SCHEME)) {
    const acct = resource.slice(ACCT_SCHEME.length);
    const atIndex = acct.indexOf('@');
    if (atIndex === -1) return undefined;
    const username = normalizeActorUsername(acct.slice(0, atIndex));
    return isHandleSwitched(policy, username) ? { username } : undefined;
  }
  const username = actorUrlUsername(resource, urls);
  if (username === undefined || !isHandleSwitched(policy, username)) return undefined;
  return {
    username,
    rewrittenResource: `${ACCT_SCHEME}${username}@${policy.federationDomain}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The switched JRD for `username`, built from the engine's answer, or `undefined`
 * when `body` is not the engine's 200 answer for exactly that account (the
 * caller then sends `body` as it is).
 */
export function switchedWebfingerJrd(
  body: unknown,
  username: string,
  { policy, urls, webOrigin }: WebfingerHandleDomainOptions,
): HandleDomainJrd | undefined {
  if (!isRecord(body) || !Array.isArray(body.links)) return undefined;
  const federationSubject = `${ACCT_SCHEME}${username}@${policy.federationDomain}`;
  if (body.subject !== federationSubject) return undefined;
  const actor = urls.actor(username);
  const links = body.links as unknown[];
  if (!links.every(isRecord)) return undefined;
  const self = (links as WebfingerJrd['links']).find((link) => link.rel === 'self');
  if (self?.href !== actor) return undefined;
  const profilePage = `${webOrigin}/@${username}`;
  return {
    subject: `${ACCT_SCHEME}${username}@${policy.handleDomain}`,
    aliases: [actor, profilePage, federationSubject],
    links: (links as WebfingerJrd['links']).map((link) =>
      link.rel === PROFILE_PAGE_REL ? { ...link, href: profilePage } : link,
    ),
  };
}

/**
 * The WebFinger router with switched accounts answered on the handle domain.
 * With the policy inactive (the default) it is the given router itself.
 */
export function withWebfingerHandleDomain(
  router: RequestHandler,
  options: WebfingerHandleDomainOptions,
): RequestHandler {
  if (!isHandlePolicyActive(options.policy)) return router;
  const wrapper = Router();
  wrapper.get('/webfinger', (req, res, next) => {
    const target = switchedWebfingerTarget(req.query.resource, options);
    if (target === undefined) return next();
    if (target.rewrittenResource !== undefined) {
      pinQuery(req, { ...req.query, resource: target.rewrittenResource });
    }
    const send = res.json.bind(res);
    res.json = ((body: unknown) => {
      const switched =
        res.statusCode === 200 ? switchedWebfingerJrd(body, target.username, options) : undefined;
      return send(switched ?? body);
    }) as typeof res.json;
    return next();
  });
  wrapper.use(router);
  return wrapper;
}
