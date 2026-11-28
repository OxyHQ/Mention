/**
 * `promotion`: posts whose author paid to reach more people (docs/boost.md).
 *
 * It does exactly one thing: put a running promotion's post into the candidate
 * pool of a ranked feed, with the rank multiplier its schedule calls for. After
 * that the post is an ordinary candidate. It is a DISCOVERY source (not
 * `trusted`), so it passes the discovery gate and `capDiscoveryShare` like every
 * other post that reaches someone who did not follow its author — which is also
 * what bounds how much of a page can be paid for. Payment buys candidacy and a
 * bounded lift; it buys no exemption from a filter, a block or a mute.
 *
 * The same predicates the feed uses everywhere else define who may see it:
 * public and published, not a reply, not a repost, outside content gates
 * (`discoverySafeSql`), an author whose audience is open, not an author the
 * viewer muted/blocked/hid, in the viewer's languages, not already seen. On top
 * of that, a viewer already counted for the promotion today is not shown it
 * again (the impression ledger is also the frequency cap).
 *
 * Fail-soft by construction: switched off, signed out, or on any error it
 * returns nothing, and the feed is exactly what it was without it.
 */

import { and, eq, exists, inArray, not } from 'drizzle-orm';
import { MtnConfig } from '@mention/shared-types';
import { getDb } from '../../../../db/postgres';
import { openAudienceAuthorSql } from '../../../../db/userProfile/profileAudience';
import { assembleShellRecords } from '../../../../db/posts/postRepository';
import { listDeliverablePromotions, utcDay } from '../../../../db/promotions/promotionRepository';
import { posts } from '../../../../db/schema/posts';
import { postPromotionImpressions, postPromotions } from '../../../../db/schema/promotions';
import {
  isAheadOfSchedule,
  promotionMultiplier,
} from '../../../../services/monetization/promotion/pacing';
import { logger } from '../../../../utils/logger';
import { authorNotInSql, excludeSeenSql, notARepostSql } from '../../../../utils/feedQueryBuilder';
import { notCollapsedCrosspostSql } from '../../../../utils/feedQueryBuilder';
import { discoverySafeSql } from '../../feedSafety';
import { viewerLanguageSql } from '../../feedLanguage';
import type { CandidatePost, SourceModule } from '../types';

export const promotionSource: SourceModule = {
  id: 'promotion',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const config = MtnConfig.promotion;
    const viewer = ctx.currentUserId;
    if (!config.enabled || !viewer) return [];

    try {
      const now = new Date();
      const running = (await listDeliverablePromotions(now, config.maxCandidates)).filter(
        (promotion) =>
          promotion.startsAt &&
          promotion.endsAt &&
          !isAheadOfSchedule(
            { ...promotion, startsAt: promotion.startsAt, endsAt: promotion.endsAt },
            now,
            config,
          ),
      );
      if (running.length === 0) return [];

      const db = getDb();
      const excludeAuthors = authorNotInSql([
        viewer,
        ...(ctx.userBehavior?.hiddenAuthors ?? []),
        ...(ctx.userBehavior?.mutedAuthors ?? []),
        ...(ctx.userBehavior?.blockedAuthors ?? []),
        ...(ctx.excludedAuthorIds ?? []),
        ...(ctx.viewerPrivacy?.blockedIds ?? []),
      ]);
      const language = viewerLanguageSql(ctx.viewerBaseLanguages);
      const seen = excludeSeenSql(ctx.seenPostIds ?? []);

      const rows = await db
        .select()
        .from(posts)
        .where(
          and(
            inArray(
              posts.id,
              running.map((promotion) => promotion.postId),
            ),
            eq(posts.visibility, 'public'),
            eq(posts.status, 'published'),
            eq(posts.isReply, false),
            notARepostSql(),
            notCollapsedCrosspostSql(),
            discoverySafeSql(),
            openAudienceAuthorSql(),
            excludeAuthors,
            language,
            seen,
            // Already counted for this viewer today: the ledger is the frequency cap.
            not(
              exists(
                db
                  .select({ one: postPromotionImpressions.promotionId })
                  .from(postPromotionImpressions)
                  .innerJoin(
                    postPromotions,
                    eq(postPromotions.id, postPromotionImpressions.promotionId),
                  )
                  .where(
                    and(
                      eq(postPromotions.postId, posts.id),
                      eq(postPromotionImpressions.viewerOxyUserId, viewer),
                      eq(postPromotionImpressions.day, utcDay(now)),
                    ),
                  ),
              ),
            ),
          ),
        )
        .limit(cap);

      const byPost = new Map(running.map((promotion) => [promotion.postId, promotion]));
      const shells: CandidatePost[] = assembleShellRecords(rows);
      return shells.flatMap((shell) => {
        const promotion = byPost.get(shell.id);
        if (!promotion?.startsAt || !promotion.endsAt) return [];
        shell._unassembled = true;
        shell.promotionBoost = promotionMultiplier(
          { ...promotion, startsAt: promotion.startsAt, endsAt: promotion.endsAt },
          now,
          config,
        );
        return [shell];
      });
    } catch (error) {
      logger.warn('[Feed] promotion source failed; serving the feed without it', { error });
      return [];
    }
  },
};
