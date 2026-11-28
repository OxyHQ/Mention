/**
 * WebFinger on the web alias hosts (`mention.org`, docs/mention-org-domain-move.md).
 *
 * The shared engine router (`@oxy.so/federation/node` `createWebfingerRouter`)
 * answers for exactly one `acct:` domain, FEDERATION_DOMAIN, and refuses any other
 * with `404 Unknown domain`. Mention is also served on alias hosts, so someone who
 * searches `@alice@mention.org` from a remote server must find the SAME local actor
 * as `@alice@mention.earth`.
 *
 * This wrapper rewrites an alias-domain `resource` to the federation domain before
 * the engine reads it, and changes nothing else: the JRD `subject` stays
 * `acct:<user>@<FEDERATION_DOMAIN>` and the `self` / profile links stay at their
 * canonical URLs, which is what tells a remote server the canonical account. No
 * actor id, key id or object id changes, and only `acct:` resources are touched.
 */
import { isSameFederationHost } from '@oxy.so/federation';
import { type Request, type RequestHandler, Router } from 'express';

const ACCT_SCHEME = 'acct:';

/**
 * The `resource` rewritten to the federation domain when it names one of the
 * alias domains, or `undefined` when it is left as it is. Parsed exactly as the
 * engine parses it: the domain is everything after the first `@`, trimmed.
 */
export function canonicalWebfingerResource(
  resource: unknown,
  domain: string,
  aliasDomains: readonly string[],
): string | undefined {
  if (typeof resource !== 'string' || !resource.startsWith(ACCT_SCHEME)) return undefined;
  const acct = resource.slice(ACCT_SCHEME.length);
  const atIndex = acct.indexOf('@');
  if (atIndex === -1) return undefined;
  const acctDomain = acct.slice(atIndex + 1).trim();
  if (isSameFederationHost(acctDomain, domain)) return undefined;
  if (!aliasDomains.some((alias) => isSameFederationHost(acctDomain, alias))) return undefined;
  return `${ACCT_SCHEME}${acct.slice(0, atIndex)}@${domain}`;
}

/** Pin a query on this request; Express 5 re-parses `req.query` from the URL on every read. */
function pinQuery(req: Request, query: Request['query']): void {
  Object.defineProperty(req, 'query', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: query,
  });
}

/**
 * The engine WebFinger router, answering the alias domains as its own. With no
 * aliases it is the engine router unchanged.
 */
export function withWebfingerAliasDomains(
  engineRouter: RequestHandler,
  { domain, aliasDomains }: { domain: string; aliasDomains: readonly string[] },
): RequestHandler {
  if (aliasDomains.length === 0) return engineRouter;
  const router = Router();
  router.get('/webfinger', (req, _res, next) => {
    const resource = canonicalWebfingerResource(req.query.resource, domain, aliasDomains);
    if (resource !== undefined) pinQuery(req, { ...req.query, resource });
    next();
  });
  router.use(engineRouter);
  return router;
}
