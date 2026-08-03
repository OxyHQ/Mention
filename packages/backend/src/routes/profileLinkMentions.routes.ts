import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import {
  MAX_PROFILE_LINKS_PER_BODY,
  type ProfileLinkMentionAnswer,
  type ProfileLinkMentionsResponse,
} from '@mention/shared-types';
import { RedisStore } from '../middleware/rateLimitStore';
import { resolveProfileLinkIdentity } from '../services/profileLinkMentions';
import { resolveUserSummaries } from '../services/PostHydrationService';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';

/**
 * WOULD THIS URL BECOME A MENTION, AND OF WHOM.
 *
 * A profile link in a body is folded into that post's real mentions when it is
 * stored: the id lands in `post.mentions`, which puts the post in that person's
 * mentions feed, notifies them, and — for a federated identity — delivers the
 * post to their instance. The composer therefore has to be able to SAY so before
 * the author sends, or pasting a URL rings somebody's phone with nothing on
 * screen having said it would.
 *
 * The composer can answer that itself for a profile on THIS instance (a username
 * lookup). It cannot for a link to another fediverse host, which is folded just
 * the same whenever we already store that actor: the answer lives in
 * `FederatedActor` rows. This endpoint is those rows' lookup-only front door.
 *
 * IT IS LOOKUP-ONLY, AND THAT IS THE WHOLE POINT. `GET /federation/resolve` is
 * NOT a substitute: it FETCHES the actor and stores it, so asking it would make
 * the composer CAUSE the mention it is describing — a link that would have
 * stayed a link becomes resolvable because we looked at it. This route calls
 * {@link resolveProfileLinkIdentity}, the same function the fold calls, which has
 * no fetching seam to pass: its remote arm queries stored actors and nothing
 * else. Nothing here ever dereferences a URL an author typed.
 *
 * IT DECIDES FROM THE URL, NOT FROM A HANDLE, for the same reason: the fold
 * decides from the URL, and a second decision made from a handle the caller
 * extracted is a second matcher that can disagree with the first. Passing the URL
 * through means the screen and the write path resolve the identical characters
 * through the identical code.
 *
 * A URL WE CANNOT ANSWER FOR YIELDS `null`, never an error. The write boundary is
 * fail-soft per link — a lookup it could not complete leaves the link a link — so
 * under-stating is the direction that keeps the two in agreement.
 */
const router = Router();

/**
 * Per-caller bound for the composer's roster.
 *
 * The client debounces, so a person composing normally spends a handful of
 * requests on a whole post; this exists to bound a client that stops debouncing,
 * not to police typing. Its own prefix rather than a shared one:
 * `rateLimitStore`'s Lua sets a TTL only when it CREATES the key, so two
 * limiters sharing a prefix share a counter AND whichever window arrived first
 * (`__tests__/middleware/rateLimitPrefixUniqueness.test.ts` enforces this).
 */
export const profileLinkMentionsRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:profile-link-mentions:', windowMs: 60 * 1000 }),
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req: Request) => {
    const authReq = req as AuthRequest;
    return authReq.user?.id ? `user:${authReq.user.id}` : hashedIpKey(req);
  },
  message: { error: 'Too Many Requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * The URLs to answer for.
 *
 * Every element is validated as an http(s) URL BEFORE anything looks it up —
 * these are characters an author typed, so a `javascript:`/`file:` string or a
 * bare word must be refused at the boundary rather than relied on to fall out of
 * a downstream matcher. The list is capped at {@link MAX_PROFILE_LINKS_PER_BODY},
 * the same ceiling the fold spends its lookups under, so no caller can ask this
 * route for more work than a post could ever cause.
 */
const requestSchema = z.object({
  urls: z
    .array(
      z
        .string()
        .max(2048)
        .refine((value) => {
          try {
            const { protocol } = new URL(value);
            return protocol === 'https:' || protocol === 'http:';
          } catch {
            return false;
          }
        }, 'must be an http(s) URL'),
    )
    .max(MAX_PROFILE_LINKS_PER_BODY),
});

/**
 * POST /mentions/profile-links
 *
 * Body `{ urls: string[] }` (≤ {@link MAX_PROFILE_LINKS_PER_BODY}); answers
 * `{ links: [{ url, mention }] }`, one entry per URL in request order.
 *
 * A batch rather than one request per URL because a body's links are one
 * question — and because a cap on the batch is what bounds the work a single
 * request can ask for.
 */
router.post('/profile-links', async (req: AuthRequest, res: Response) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  // Distinct URLs are resolved once: a body can name one person through two
  // spellings, and each spelling still gets its own answer below.
  const urls = parsed.data.urls;
  const distinct = [...new Set(urls)];

  try {
    const identities = new Map<string, string>();
    await Promise.all(
      distinct.map(async (url) => {
        try {
          const identity = await resolveProfileLinkIdentity(url);
          if (identity) identities.set(url, identity.oxyUserId);
        } catch (err) {
          // Fail-soft per URL, exactly as the fold is: one lookup that throws
          // leaves that link unanswered and the rest of the body unaffected.
          logger.warn('[Mentions] failed to resolve a profile link for the composer', {
            error: err,
          });
        }
      }),
    );

    // The name comes from the SAME pair `PostHydrationService` renders a stored
    // `[mention:<id>]` with — the shared summary resolver (one batched cache read,
    // one bulk Oxy fetch for the misses) and `getNormalizedUserHandle`. So the row
    // on screen names somebody exactly as the published post will.
    const summaries = await resolveUserSummaries([...identities.values()]);

    const links: ProfileLinkMentionAnswer[] = urls.map((url) => {
      const userId = identities.get(url);
      const summary = userId ? summaries.get(userId) : undefined;
      if (!userId || !summary) return { url, mention: null };
      // No handle, no mention. That covers both the unroutable case and the
      // DEGRADED placeholder an Oxy lookup that failed leaves behind, whose
      // username is empty by construction (`degradedActorSummary`) — which is
      // also exactly what `isFallbackUserSummary` tests, so asking both would be
      // one condition written twice. Reporting no mention is the right direction
      // either way: the fold is fail-soft per link, and a row reading "Unknown
      // user" would name somebody the post does not.
      const handle = getNormalizedUserHandle(summary.user);
      if (!handle) return { url, mention: null };
      return {
        url,
        mention: {
          userId,
          handle,
          displayName: summary.user.name?.displayName?.trim() || handle,
        },
      };
    });

    const response: ProfileLinkMentionsResponse = { links };
    return res.json(response);
  } catch (err) {
    logger.error('[Mentions] profile-link resolution failed', err);
    return res.status(500).json({ error: 'Resolve failed' });
  }
});

export default router;
