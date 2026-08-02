/**
 * MTN Protocol Configuration
 *
 * Centralized constants replacing magic numbers scattered across strategies.
 * All ranking weights, cache TTLs, feed params in one place.
 */

import type { FeedInterstitialKind } from '../feed';
import { TREND_CATEGORIES } from '../trending';

export const MtnConfig = {
  // --- Ranking weights ---
  ranking: {
    engagement: {
      likeWeight: 1.0,
      boostWeight: 2.5,
      /**
       * Weight for a FEDERATED boost (an inbound ActivityPub Announce, tracked by
       * `stats.federatedBoostsCount`) — deliberately LOWER than `boostWeight`
       * (2.5) because a remote Announce is a much weaker relevance signal than a
       * native repost: a handful of federated boosts routinely made low-quality
       * off-instance posts look "trending". The engagement composite weights the
       * native boost subset (`boostsCount - federatedBoostsCount`) at
       * `boostWeight` and the federated subset here.
       */
      federatedBoostWeight: 0.5,
      commentWeight: 2.0,
      saveWeight: 1.5,
      // Raised from 0.1 → 0.3 now that real impression-backed view counts flow
      // in (frontend impression reporting + deduped server-side view counting).
      // Views are a weak-but-real signal; this keeps them subordinate to likes
      // and boosts while letting a heavily-seen post edge out an unseen one.
      viewWeight: 0.3,
    },
    recency: {
      halfLifeMs: 24 * 60 * 60 * 1000, // 24 hours
      maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
    relationship: {
      followBoost: 1.8,
      strongRelation: 1.5,
      weakRelation: 1.2,
      noRelation: 0.9,
    },
    personalization: {
      topicMatch: 1.4,
      postTypeMatch: 1.3,
      languageMatch: 1.2,
    },
    /**
     * EXPLORE RELEVANCE — a LIGHT, BOUNDED lift applied ONLY to the
     * authenticated Explore (discovery) feed on top of its engagement×recency
     * score. Explore stays DISCOVERY of non-followed content — these weights do
     * NOT personalize-via-follows and they are NOT a hard filter: a non-matching
     * post still appears (for serendipity), it just ranks a bit lower than an
     * equally-engaging post that matches the viewer's learned signals.
     *
     * Deliberately GENTLER than `personalization` above (Explore is discovery,
     * not the curated For You feed) so the engagement×recency trending signal
     * still dominates. Each matched dimension multiplies in; the product is
     * clamped to `maxBoost` so no single viewer signal can dominate ranking.
     *
     * Anonymous Explore passes NO viewer signals, so every multiplier collapses
     * to exactly 1.0 (neutral) and behavior is unchanged.
     */
    exploreRelevance: {
      /**
       * Multiplier when one or more of the post's classified topics
       * (`postClassification.topics`) overlaps the viewer's `preferredTopics`.
       * Applied ONCE (presence of overlap), not scaled by match count, so a
       * multi-topic post can't run away with the score.
       */
      topicMatch: 1.25,
      /**
       * Multiplier when ANY of the post's `postClassification.languages` is one
       * of the viewer's preferred languages.
       */
      languageMatch: 1.15,
      /**
       * Multiplier when the post's `postClassification.region` equals the
       * viewer's learned coarse region. Region is best-effort/sparse, so this is
       * usually neutral (1.0); it only lifts when both sides actually carry one.
       */
      regionMatch: 1.1,
      /**
       * Hard ceiling on the COMBINED relevance multiplier (topic × language ×
       * region). Bounds the lift so relevance nudges, never overwhelms, the
       * engagement×recency trending order.
       */
      maxBoost: 1.5,
    },
    quality: {
      highEngagement: 1.3,
      lowEngagement: 0.8,
      /**
       * Minimum view count before a LOW engagement-rate post is penalized.
       * Lowered 100 → 20: real view counts are now far lower than the inflated
       * federated aggregates that existed when 100 was chosen, so the old gate
       * almost never fired. 20 views is enough signal to trust a low rate.
       */
      lowEngagementMinViews: 20,
      /**
       * Floor applied to the per-view divisor when computing engagement RATE, so
       * a post with a handful of views (e.g. 2 views, 1 like = rate 0.5) is not
       * spuriously promoted to "high quality". Below this many views we treat the
       * rate as neutral rather than letting a tiny denominator inflate it.
       */
      minViewsForRate: 20,
    },
    diversity: {
      // Strengthened so the feed mixes authors/topics more aggressively and
      // avoids a single prolific author or trending tag dominating a session.
      sameAuthorPenalty: 0.85, // was 0.95
      sameTopicPenalty: 0.80, // was 0.92
      /**
       * Minimum number of OTHER items that must appear between two items by the
       * same author in the emitted page. The soft multiplicative `sameAuthorPenalty`
       * above only nudges scores and a high-scoring author easily overpowers it,
       * producing the "5 posts in a row from one user" clustering. This is the HARD
       * spacing the post-ranking diversity rerank enforces.
       *
       * 1 = never two consecutive items by the same author.
       * 2 = at least one different author must sit between two same-author items.
       */
      authorMinGap: 2,
      /**
       * Hard cap on how many items a single author may contribute to one rendered
       * page. Prevents a prolific author from filling the page even with spacing.
       * The reranker never DROPS items — it defers an author's overflow items to
       * the tail of the page (so they appear after everyone else, or roll to the
       * next page via pagination) rather than removing them.
       */
      maxPerAuthorPerPage: 3,
    },
    /**
     * Author authority (follower-count) signal. A bounded multiplier that gives
     * established accounts a MODEST lift without letting them dominate — small
     * creators stay at the neutral floor (~1.0). Shape: 1 + k * log1p(followers),
     * clamped to [min, max]. Defaults to `max=1.0`-neutral effect only when the
     * follower count is unavailable (handled in code, not here).
     */
    authority: {
      logScale: 0.05, // k — how fast the boost grows with log(followers)
      min: 0.9, // floor (a 0-follower / unknown-but-present author)
      max: 1.4, // ceiling (a very large account)
    },
    /**
     * AI content-classification signals (`postClassification.scores`, each 0..1)
     * folded into ranking — see `FeedRankingService`. These ONLY apply when a
     * post is fully AI-classified (`postClassification.status === 'classified'`
     * AND `scores` present). Unscored / baseline / pending / failed posts are
     * treated as NEUTRAL (every multiplier below collapses to exactly 1.0), so
     * the feed never empties when AI scores are absent.
     *
     * SAFETY (spam + toxicity) folds into the negative penalty; QUALITY folds
     * into / augments the engagement-rate quality score. All effects are bounded.
     */
    aiQuality: {
      /**
       * SAFETY downrank — spam & toxicity. A score AT OR ABOVE the threshold is
       * "high" and earns the strong multiplicative penalty. Both signals share
       * the same penalty (the worse of the two dominates, since penalties
       * multiply). The penalty is strong enough to push a flagged post out of
       * the feed without hard-deleting it (multiplicative, not a filter).
       */
      safety: {
        /** spam score ≥ this → high-spam → strong downrank. */
        spamThreshold: 0.7,
        /** toxicity score ≥ this → high-toxicity → strong downrank. */
        toxicityThreshold: 0.7,
        /**
         * Multiplier applied to a high-spam OR high-toxicity post. ~0.1 pushes
         * it ~10x down — effectively out of the visible feed — while keeping the
         * model multiplicative (no special-case exclusion).
         */
        highRiskPenalty: 0.1,
      },
      /**
       * QUALITY adjustment from the AI `quality` score (0..1). At/above
       * `highThreshold` → modest boost; at/below `lowThreshold` → modest
       * downrank; in between → neutral (1.0). Bounded, so a single AI signal
       * never dominates the multiplicative score. When the AI quality score is
       * present it REPLACES the engagement-rate quality heuristic; otherwise the
       * engagement-rate behavior is preserved unchanged.
       */
      quality: {
        /** quality score ≥ this → high quality → modest boost. */
        highThreshold: 0.7,
        /** quality score ≤ this → low quality → modest downrank. */
        lowThreshold: 0.3,
        /** Multiplier for a high-quality (AI) post. */
        highBoost: 1.3,
        /** Multiplier for a low-quality (AI) post. */
        lowPenalty: 0.7,
      },
    },

    /**
     * Optional ranking signals.
     *
     * `FeedRankingService` applies one only when the resolved feed definition
     * enables its signal module. For You enables a conservative default subset;
     * custom feeds and the environment override may choose another subset. Every
     * weight remains bounded so one signal nudges rather than dominates ranking.
     */
    optInSignals: {
      /** Favor posts that carry media (image / video / gif). */
      mediaBoost: {
        /** Multiplier for a post with at least one media attachment. */
        boost: 1.15,
      },
      /** Favor positive-sentiment posts (AI Stage-B `sentiment`, provenance-gated). */
      positivity: {
        /** Multiplier for a `sentiment === 'positive'` classified post. */
        boost: 1.1,
      },
      /**
       * Favor constructive / conversational posts. Scales with the classified
       * `constructiveness` score (provenance-gated) or, absent that, the reply
       * ratio derived from `stats`. The multiplier is `1 + signal * (maxBoost-1)`,
       * so a signal of 0 collapses to neutral.
       */
      conversational: {
        /** Ceiling on the conversational multiplier (signal === 1). */
        maxBoost: 1.2,
      },
      /**
       * DISCOVERY lift for brand-new posts and low-follower ("cold") authors, to
       * help fresh content surface. Applied when the post is within `windowMs` of
       * creation OR the author's follower count is below `newAuthorFollowerThreshold`.
       */
      coldStartBoost: {
        boost: 1.15,
        /** Posts newer than this get the freshness lift. 6h. */
        windowMs: 6 * 60 * 60 * 1000,
        /** Authors with fewer followers than this are treated as cold-start authors. */
        newAuthorFollowerThreshold: 25,
      },
      /**
       * SOFT de-prioritize (not hard-exclude) posts the viewer has already seen —
       * a gentle downrank so seen content can still appear but yields to fresh
       * content. Multiplier < 1.
       */
      penalizeSeen: {
        penalty: 0.5,
      },
      /** Small lift for verified authors (Oxy `isVerified`). */
      verifiedBoost: {
        boost: 1.1,
      },
      /**
       * Lift scaled by how many of the viewer's network (following ∪ mutuals)
       * engaged the post (liked / boosted). Multiplier is `1 + count * perEngager`,
       * clamped to `maxBoost`.
       */
      socialProof: {
        perEngager: 0.1,
        maxBoost: 1.5,
      },
      /**
       * Lift for authors the viewer MUTUALLY engages with — an author who is both
       * a mutual follow AND in the viewer's learned `preferredAuthors` (weight ≥
       * `minAuthorWeight`).
       */
      reciprocityBoost: {
        boost: 1.2,
        /** Minimum learned author-affinity weight for the reciprocity lift to apply. */
        minAuthorWeight: 0.3,
      },
      /**
       * Lift for high-dwell posts — posts whose average impression duration meets
       * `thresholdMs`. Scales linearly from `boost` (at threshold) toward `maxBoost`
       * for longer dwell; neutral below threshold or when no dwell data exists.
       */
      dwellTime: {
        thresholdMs: 4000,
        boost: 1.15,
        maxBoost: 1.25,
      },
      /**
       * EXPLORATION lift for posts whose topics the viewer has NOT recently seen,
       * to break out of topic echo chambers. Applied when a post has at least one
       * topic and NONE of its topics are in the viewer's recent-topic set.
       */
      noveltyBoost: {
        boost: 1.15,
      },
      /**
       * OFF-LANGUAGE discovery PENALTY. A modest DOWNRANK — never a hard
       * filter — applied ONLY to DISCOVERY posts (`post._discovery === true`, i.e.
       * candidates that entered via a non-trusted lane) whose declared
       * `postClassification.languages` (ISO 639-1) are KNOWN and DISJOINT from the
       * viewer's account languages (`context.viewerLanguages` — BCP-47 locales
       * resolved from the Oxy account, matched on the BASE subtag, so an `es-ES`
       * viewer matches an `es` post). Neutral (1.0) when the viewer has no known languages, the post
       * declares no language, the languages overlap, or the post is from a TRUSTED
       * lane (followed/affinity/lists are never `_discovery`). Off-language content
       * is deliberately PENALIZED, not removed — a good off-language post can
       * still surface, it just yields to on-language content.
       */
      languageMismatchPenalty: {
        /** Multiplier (< 1) applied to an off-language discovery post. */
        penalty: 0.5,
      },
      /**
       * MODEST LOCAL-priority lift. A small boost for LOCAL posts
       * (`federation` absent/null); neutral (1.0) for federated posts. Complements
       * the `federatedBoostWeight` engagement dampening by giving first-party
       * content a light edge without suppressing federated discovery.
       */
      localBoost: {
        /** Multiplier (> 1) applied to a local (non-federated) post. */
        boost: 1.1,
      },
      /**
       * STARTER-PACK CURATION boost — a bounded lift for an author OTHER PEOPLE
       * curated into their starter packs, weighted by how much those packs are
       * actually USED and by the curator's own follower count.
       *
       * A starter pack contains USERS, so the signal is author-level: "humans who
       * are not this author put them on a list newcomers actually followed". That
       * is a strong, human-in-the-loop endorsement — precisely the thing raw
       * engagement counts miss for a good author with a thin follow graph.
       *
       * SCORE (see `services/starterPackCuration.ts`), per author A:
       *   candidate packs = packs where A ∈ members
       *                     AND owner !== A                  (rule 1)
       *                     AND useCount >= minUseCount      (rule 2)
       *   curatorAuthority(owner) = clamp(1 + logScale · log1p(ownerFollowers),
       *                                   min, max)          — unknown ⇒ `min`
       *   packWeight              = log1p(useCount) · curatorAuthority(owner)
       *   starterPackScore        = clamp(Σ over the top `maxCuratorsPerAuthor`
       *                                   DISTINCT curators of their best
       *                                   packWeight, 0, maxScore)   (rules 3, 4)
       * SIGNAL:
       *   multiplier = clamp(1 + scale · log1p(starterPackScore), 1, maxBoost)
       *
       * ANTI-GAMING (the whole point — every rule below is load-bearing):
       *  1. SELF-OWNED PACKS ARE EXCLUDED. Otherwise anyone creates a pack, adds
       *     themselves, and self-boosts.
       *  2. ONLY CROWD-VALIDATED PACKS COUNT (`useCount >= minUseCount`). A pack
       *     nobody ever used endorses nothing — and `useCount` only increments for
       *     a DISTINCT user who actually followed through it.
       *  3. DEDUPE BY CURATOR, NOT BY PACK. Each distinct curator contributes their
       *     single BEST pack, so one curator spinning up 50 packs counts ONCE.
       *  4. EVERYTHING IS BOUNDED and LOG-SCALED: at most `maxCuratorsPerAuthor`
       *     curators count, the summed score is clamped to `maxScore`, and the
       *     final multiplier is clamped to `maxBoost`. A sybil ring of low-follower
       *     accounts curating each other therefore earns a small, capped lift —
       *     never a takeover — while `curatorAuthority` gives a real curator with a
       *     real audience up to a `max`/`min` (=1.5×) edge per pack.
       *  5. NEVER PENALIZES. An uncurated author scores 0 ⇒ multiplier exactly 1.0.
       */
      starterPackBoost: {
        /** Ceiling on the multiplier — the MOST curation can ever be worth. */
        maxBoost: 1.35,
        /** Growth rate of the lift in `log1p(starterPackScore)`. */
        scale: 0.12,
        /**
         * How much a curator's own audience weights their endorsement. Same
         * bounded log shape as `ranking.authority`, but its floor is a NEUTRAL
         * 1.0: a curator with no (or unresolved) followers still endorses at full
         * base weight — they are simply never AMPLIFIED. `max` caps a mega-account
         * curator's edge at 1.5× per pack.
         */
        curatorAuthority: {
          logScale: 0.05,
          /** Floor — also the value used when the curator's follower count is unknown. */
          min: 1.0,
          /** Ceiling for a very large curator. */
          max: 1.5,
          /**
           * TTL (seconds) of the DEDICATED curator follower-count cache
           * (`curatorfollowers:v1:<id>` — see `services/curatorFollowerCounts.ts`).
           * Deliberately much longer than the 10-minute identity cache: a follower
           * count is a coarse, slow-moving input to a bounded log-scale factor, so
           * an hour-stale value cannot move the multiplier meaningfully, and the
           * long TTL is what keeps the Oxy fan-out for cold curators negligible.
           */
          cacheTtlSeconds: 60 * 60,
        },
        /** A pack must have been USED at least this many times to endorse anyone. */
        minUseCount: 1,
        /** At most this many DISTINCT curators contribute to one author's score. */
        maxCuratorsPerAuthor: 10,
        /**
         * Clamp on the summed score. With `scale`, a score at this cap already
         * saturates the multiplier at `maxBoost`, so nothing above it can matter.
         */
        maxScore: 25,
      },
    },
  },

  // --- Feed parameters ---
  feed: {
    candidateMultiplier: 3,
    sliceOverfetchMultiplier: 1.5,
    maxSliceSize: 3,
    defaultLimit: 30,
    maxLimit: 100,
    trendingWindowMs: 24 * 60 * 60 * 1000, // 24 hours
    /** Minimum score difference to distinguish cursor position */
    scoreEpsilon: 0.001,

    /**
     * FEED INTERSTITIALS — the recommendation cards (suggested users / custom
     * feeds / starter packs) spliced between post slices while the viewer
     * scrolls.
     *
     * The server picks the KIND and the POSITION; the client fetches the
     * CONTENT lazily from the dedicated recommendation endpoints. Planning a
     * slot is therefore pure arithmetic over data the feed request already has
     * (`followingIds.length`) and costs the feed response zero extra I/O.
     *
     * The mix adapts to how dense the viewer's follow graph is, because what a
     * user needs changes with it: someone who follows almost nobody gets
     * starter packs first (one tap follows many people at once), while someone
     * who already follows hundreds mostly wants individual accounts, less
     * often.
     */
    interstitials: {
      /** Feed descriptors allowed to carry cards. Any other feed gets none. */
      allowedDescriptors: ['for_you', 'following', 'explore'],
      /** Below this many follows the graph is COLD — bootstrap it aggressively. */
      coldMaxFollowing: 20,
      /** Above this many follows the graph is DENSE — nudge sparingly. */
      denseMinFollowing: 150,
      /**
       * 0-based slice indices a card is anchored AFTER. A cold viewer sees one
       * early (slice 3) so discovery starts before they bounce; everyone else
       * gets the first card deep enough (slice 8) that the feed still reads as
       * a feed. A page shorter than the requested index simply yields no card.
       */
      positions: {
        cold: { firstPage: [3, 20], nextPage: [12] },
        warm: { firstPage: [8], nextPage: [12] },
        dense: { firstPage: [8], nextPage: [12] },
      },
      /**
       * Rotation order of card kinds, cycled per slot, per graph temperature.
       *
       * `trendingTopics` is in the COLD and WARM rotations only. A viewer whose
       * follow graph is near-empty has nothing in Following, and trends are the
       * one discovery surface that works with zero graph — while a dense viewer
       * already has a feed and wants accounts, not headlines.
       */
      rotation: {
        cold: ['suggestedStarterPacks', 'trendingTopics', 'suggestedUsers', 'suggestedFeeds'] satisfies FeedInterstitialKind[],
        warm: ['suggestedUsers', 'suggestedFeeds', 'trendingTopics', 'suggestedStarterPacks'] satisfies FeedInterstitialKind[],
        dense: ['suggestedUsers', 'suggestedUsers', 'suggestedFeeds'] satisfies FeedInterstitialKind[],
      },
      /**
       * Dense graphs only get a card every Nth page (deterministic off the
       * cursor, never random — the same page must always plan the same slots).
       */
      densePageInterval: 2,
      /**
       * The PROFILE (author) feed carries exactly one card: accounts similar to
       * the profile being read. It is deliberately outside the graph-temperature
       * model above — that model asks "how much bootstrapping does this VIEWER
       * need", whereas this card is about the SUBJECT of the feed, and is just as
       * useful to a viewer who already follows a thousand people.
       *
       * The server drops it on your own profile (there is nobody "similar to you"
       * worth suggesting to you).
       */
      profile: {
        /** 0-based slice indices to anchor after, per page. */
        positions: { firstPage: [5], nextPage: [] },
      },
    },

    /**
     * MULTI-SOURCE candidate generation for the AUTHENTICATED For You feed.
     *
     * The old behavior ranked only the global newest-N public posts, so ranking
     * never even SAW relevant posts from followed / affinity / preferred-topic
     * authors unless they happened to be in the global-recency window. On a noisy
     * federated instance that is mostly irrelevant. Instead we gather a UNION of
     * several bounded, parallel candidate sub-queries — each consuming a
     * different personalization signal — and feed that union into the SAME
     * rank → dedup → never-blank → diversify → page → cursor pipeline.
     *
     * Every source is recency-windowed and per-source capped; the merged pool is
     * additionally bounded by `maxPool`. All caps live here — NO magic numbers in
     * the candidate-generation code.
     */
    candidateSources: {
      /**
       * Hard ceiling on the merged (deduped) candidate pool fed into ranking.
       * Bounds ranking + slicing cost regardless of how many sources contribute.
       * ~150 keeps the pool rich enough for personalization + diversity while
       * staying cheap to rank.
       */
      maxPool: 150,
      /**
       * Recency window (ms) every source draws from. A post older than this is
       * not a candidate. 3 days balances freshness against having enough
       * personalized supply on a low-volume instance.
       */
      recencyWindowMs: 3 * 24 * 60 * 60 * 1000,
      /**
       * Hard cap on how many distinct author ids any single id-set source
       * (FOLLOWING, AFFINITY) may query with. Bounds the `$in` width and keeps
       * the query index-served and predictable.
       */
      maxAuthorIds: 500,
      /** Per-source result caps (each query `.limit()`s to its cap). */
      perSource: {
        /** Recent posts from authors the viewer FOLLOWS (incl. federated + subscribed lists). */
        following: 60,
        /** Recent posts from AFFINITY authors (preferredAuthors ∪ ContentAffinityService). */
        affinity: 40,
        /** DISCOVERY: recent posts matching the viewer's preferred topics. */
        topics: 30,
        /** DISCOVERY: recent posts in the viewer's preferred language(s). */
        language: 20,
        /** DISCOVERY: recent posts in the viewer's region. */
        region: 15,
        /** DISCOVERY: recent high-engagement (trending) posts. */
        trending: 25,
        /** DISCOVERY: recent public posts (the old global behavior) — small, for serendipity. */
        global: 20,
      },
      /**
       * How many top author ids to draw from each affinity source before
       * unioning + de-duplicating them (then clamped to `maxAuthorIds`).
       */
      maxPreferredAuthors: 100,
      maxAffinityCandidates: 50,
      /**
       * How many of the viewer's preferred topic slugs / languages to query with.
       * Bounds the multikey `$in` width on the indexed discovery sources.
       */
      maxPreferredTopics: 20,
      maxPreferredLanguages: 5,
      /** Per-source query time budget (ms). */
      maxTimeMS: 4000,
    },

    /**
     * DISCOVERY GATE for the authenticated For You feed — a hard quality/bot/
     * engagement floor applied ONLY to candidates from non-trusted (discovery)
     * lanes (topics / language / region / trending / global). Trusted lanes
     * (following / affinity / subscribed-lists) are NEVER gated.
     *
     * WIRED IN PHASE 4, shipping in SHADOW mode. `shadow: true` means the engine
     * EVALUATES the gate on each discovery candidate and records/marks what it
     * WOULD reject, but drops nothing — so served For You output is unchanged
     * until `shadow` is flipped to `false` (after prod validation). The gate is
     * applied by `FeedEngine.gatherPool` via `forYouDefinition.discoveryFilters`
     * (see `resolveDiscoveryGate`), ONLY to candidates from non-trusted lanes.
     */
    discoveryGate: {
      /** Master switch. When false the gate is fully bypassed (no compute, no metrics). */
      enabled: true,
      /**
       * Measure-don't-filter mode. When true the gate evaluates each discovery
       * candidate and records what it WOULD reject, but lets every post through —
       * used to validate precision/recall in prod before enforcing.
       */
      shadow: true,
      /**
       * Minimum raw `content.text` length (characters) for a discovery post. Below
       * this a post with no media/poll is treated as empty. Reuses the existing
       * `minLength` filter primitive.
       */
      minTextLength: 3,
      /**
       * Minimum MEANINGFUL text length (characters) after stripping shortcodes,
       * URLs, mentions/hashtags and emoji. Below this AND with no media/poll, the
       * post is emoji/shortcode-only low-effort — the objective-junk case.
       */
      minMeaningfulTextLength: 12,
      /**
       * Native-engagement floor: `likes + comments + max(0, boosts −
       * federatedBoostsCount) ≥ this` lets a discovery post pass the engagement
       * branch. Federated Announces do NOT count toward this floor (that is the
       * whole point of tracking `federatedBoostsCount`).
       */
      minNativeEngagement: 1,
      /**
       * Spam score AT OR ABOVE this (with trusted provenance only) hard-rejects a
       * discovery post. Set high so only confident spam is dropped — never the
       * all-zeros default, so the feed can never empty.
       */
      spamRejectThreshold: 0.8,
      /**
       * Quality score AT OR BELOW this (with trusted provenance only) hard-rejects
       * a discovery post. Set low for the same never-empty reason.
       */
      qualityRejectThreshold: 0.2,
      /**
       * Freshness grace window (ms). A brand-new discovery post younger than this
       * passes the engagement branch even with zero native engagement, so fresh
       * content still surfaces (cold-start). 6 hours.
       */
      freshnessGraceMs: 6 * 60 * 60 * 1000,
      /**
       * Minimum topic-overlap weight for a discovery post to pass via the
       * personalization branch (post topic matches the viewer's preferred topics).
       * Lets on-interest discovery through even without native engagement.
       */
      strongTopicWeight: 0.3,
    },

    /** For You feed composition knobs. */
    forYou: {
      /**
       * Maximum SHARE (0..1) of a rendered For You page that may come from
       * discovery lanes, guaranteeing a floor for trusted (following/affinity)
       * content. `capDiscoveryShare` defers — never discards — discovery slices
       * above `floor(maxDiscoveryShare · limit)`. On thin social graphs the cap
       * simply is not reached and discovery backfills.
       */
      maxDiscoveryShare: 0.7,
    },
  },

  /** Trending topics — the list itself is not a feed, but it is tuned like one. */
  trending: {
    /**
     * The VOLUME SPARKLINE shown beside a trend.
     *
     * The series is read from the `Trending` collection itself, which is the only
     * place a per-name time series exists: the job inserts a full batch every 30
     * minutes and a unique `{name, calculatedAt}` index serves the per-name range
     * scan directly. (`TopicStats` cannot be used — it holds one current-value row
     * per topic and no history at all.)
     *
     * Every number here is a presentation bound on REAL measurements. Nothing in
     * this feature synthesizes a point: a trend without enough history gets no
     * chart, never a placeholder line.
     */
    series: {
      /**
       * How far back the series reaches. 24 hours ≈ 48 batches at the 30-minute
       * cadence, and it matches the window `volume` itself is counted over, so a
       * point and its axis describe the same span.
       */
      windowMs: 24 * 60 * 60 * 1000,
      /**
       * Points on the wire after downsampling. Fixed so the response size and the
       * SVG geometry are constant no matter how many batches a name appears in
       * (observed: 34–52 for the trends actually rendered). Twelve is comfortably
       * more shape than 50 device-independent pixels can resolve, so raising it
       * would cost bytes and draw nothing new.
       */
      maxPoints: 12,
      /**
       * COVERAGE FLOOR: fewer real points than this and the trend ships no series
       * at all, so the client draws nothing.
       *
       * Chosen against measured prod data (148 batches over 7 days, 1,294 rendered
       * trend-instances at the widget's limit of 10). Share that would draw:
       * ≥2 points 94.0% · ≥3 89.3% · ≥4 84.9% · ≥6 76.0% · ≥8 69.5% · ≥12 57.0%.
       *
       * Six wins on what the line has to SAY, not on coverage. Two points are one
       * straight segment, which encodes exactly what the direction arrow already
       * encodes; three can bend once, but at the 30-minute cadence that is 90
       * minutes of history where a single noisy batch is a third of the picture.
       * Six points is three hours and five segments — the shortest span that reads
       * as a shape rather than a zigzag — and it is the density the 50×24 chart was
       * drawn for. The price is that roughly one rendered trend in five shows no
       * chart, which is the honest outcome for a trend nobody has watched long
       * enough yet.
       */
      minPoints: 6,
    },

    /**
     * TERM EXTRACTION — the Stage-A ingest step that decides what a post is
     * ABOUT, in the vocabulary trending measures.
     *
     * Bounds only. The extractor holds the linguistics (stop words, tokenizing,
     * phrase runs); everything here is a size limit, so tuning how much a post
     * may contribute never means editing the algorithm.
     */
    terms: {
      /**
       * Shortest token kept. Two-letter tokens are overwhelmingly particles,
       * initials and units that survive stop-word filtering in every language
       * at once, and they cannot carry a trend on their own.
       */
      minTokenLength: 3,
      /**
       * Longest token kept. Above this a "word" is a URL fragment, a base64
       * blob or a keysmash — never something a reader would recognise as a
       * topic — and it would otherwise bloat the stored array and its index.
       */
      maxTokenLength: 32,
      /**
       * Longest PHRASE, in tokens. Two is what the shape of real trends asks
       * for: a person (`todd blanche`), an event (`kremer trade`), a tag
       * (`frightclub`). Three-token phrases multiply the candidate space
       * without adding trends that the two-token prefix does not already carry.
       */
      maxPhraseTokens: 2,
      /**
       * Terms stored per post. A cap is what keeps the multikey index bounded:
       * without one, a single long post writes hundreds of index entries. Terms
       * are emitted in reading order, so the cap keeps the opening of the post —
       * which is where its subject almost always is.
       */
      maxTermsPerPost: 12,
    },

    /**
     * DETECTION — how the 30-minute batch decides what is trending.
     *
     * The measurement is a BURST, not a total: a term's rate over the recent
     * window is compared against the rate implied by its own trailing window,
     * and the score is how far the observation sits above what that baseline
     * predicts. This is the whole reason a permanently-popular hashtag stops
     * outranking real news — it is enormous but perfectly steady, so it predicts
     * itself and scores ~0.
     */
    detection: {
      /**
       * Trailing window that establishes the BASELINE rate, and over which
       * `volume` is counted. Also the window the sparkline is drawn over, so a
       * point and its axis describe the same span.
       */
      windowMs: 24 * 60 * 60 * 1000,
      /**
       * The RECENT window whose rate is tested against the baseline. A quarter
       * of the trailing window: long enough that a handful of posts does not
       * swing the rate, short enough that a story breaking now is visible within
       * one or two batches.
       */
      recentWindowMs: 6 * 60 * 60 * 1000,
      /**
       * Distinct AUTHORS a term needs before it can trend at all. The floor is
       * on people, not posts, because posts are the thing a single account can
       * manufacture: fifty posts from one author is not a trend, and counting
       * posts alone made that indistinguishable from fifty people agreeing.
       */
      minAuthors: 3,
      /**
       * Posts a term needs in the trailing window.
       *
       * Guards the rate estimate itself: below a handful of observations the
       * burst statistic measures a coincidence precisely.
       *
       * Briefly raised to 8 to remove `why`, `right` and `will` from the live
       * list, which emptied it completely — and that was the wrong lever pulled
       * for the right complaint. Those terms are noise because of WHAT THEY
       * ARE, and the stop-word filter that now runs at detection removes them
       * by name at any volume. This floor only has to exclude counts too small
       * to estimate a rate from; asking it to do semantics as well is what
       * costs a small network its entire list.
       *
       * Measured against the batches of 2026-08-01: at 5, `why`/`will` are
       * gone by name, `right` (4 posts) is gone by count, and `music` (5) and
       * `politics` (11) survive — which is the list this network actually has.
       */
      minVolume: 5,
      /**
       * VOCABULARY CEILING: the share of ALL posts in the window a term may
       * appear in before it is treated as vocabulary rather than a subject.
       *
       * A stop-word list can only ever hold the words somebody thought of, in
       * the languages somebody speaks. This asks the corpus instead: a term
       * carried by a large fraction of everything posted is how this network
       * talks, not what it is talking about — and that holds in any language,
       * for slang, and for whatever the next surprise is.
       *
       * SCALE-SENSITIVE, and the first value chosen was wrong for this network.
       * 3% was intuition borrowed from Bluesky's size, where a huge story like
       * `fifa` (1,897 posts) is still a hundredth of a percent of the day. On a
       * network whose busiest term of the day is twenty posts, a legitimate
       * trend IS several percent of everything — so 3% deleted `politics` (11
       * posts, 4 authors) as vocabulary and emptied the list.
       *
       * A quarter is the level at which the claim actually holds: a term
       * carried by one post in four is how the network talks, whatever it is.
       * Real vocabulary sits far above it and real subjects far below, so the
       * gap between them is what makes the number safe rather than tuned.
       *
       * The stop-word list, not this, is what removes function words — they are
       * refused by NAME at any frequency. This exists for the terms no list
       * anticipates.
       */
      maxDocumentFrequency: 0.25,
      /**
       * CONCENTRATION CEILING: posts per distinct author a term may average
       * before it is refused entirely.
       *
       * The author floor asks "how many people?", which one prolific account
       * walks past the moment a second one joins it. This asks the other half —
       * "is anyone saying this more than a few times?" — and it is the guard
       * that actually matches how automated posting looks on this network.
       *
       * Measured on Mention's own trending list, 2026-08-01: `#noticia` was 20
       * posts from ONE account, `#ultimanoticia` 10 from the same one, and
       * `#cartoon` 40 posts from TWO accounts alternating. Those three were the
       * top of the list. Every real conversation has the opposite shape — many
       * people saying something once or twice — so a ceiling of four separates
       * them cleanly without needing to identify anybody as a bot.
       */
      maxPostsPerAuthor: 4,
      /**
       * How many trends a batch tries to report before it is willing to fall
       * back on popularity (see `topUpWithPopular`). A list of one or two is
       * not a list, so the top-up fills toward this and stops.
       */
      minTrends: 5,
      /**
       * Posts a term needs before POPULARITY alone can put it on the list —
       * deliberately higher than {@link minVolume}.
       *
       * The two paths make different claims and so need different evidence. A
       * burst can be small, because the shape of the spike is the signal: four
       * of five posts arriving in the last few hours means something even at
       * five posts. "People are posting about this" means nothing at five
       * posts — it is just five posts.
       *
       * Live batch, 2026-08-01: `came` reached the widget with a volume of 3
       * and a NEGATIVE burst score. No statistical guard can save a list at
       * that size, and no stop-word list will ever contain every inflected
       * form of every common verb. The honest fix is to require the popular
       * path to actually be popular.
       *
       * RECALIBRATED once a term had to NAME something. This bar was doing two
       * jobs: proving there was enough evidence, and standing in for "is this a
       * subject at all?" — which it could only ever do by proxy, because the
       * term space was then full of ordinary words whose volume came from
       * everyone who happened to use them. The naming rule answers the second
       * question upstream now, and it shrank every count with it: `Ukraine`, a
       * real subject, measured exactly 10, fell short on the next batch, and
       * left the list empty.
       *
       * So this returns to being an evidence floor and nothing more. Whether a
       * term is a name is no longer this number's question to answer.
       */
      minPopularVolume: 5,
      /**
       * How far above its own baseline a term must sit to be reported, in
       * standard deviations of the Poisson count it is compared against.
       * Everything below this is ordinary fluctuation of an ordinary term.
       */
      minBurstScore: 1.5,
      /**
       * Burst score at which a trend is marked `hot`. Deliberately far above
       * {@link minBurstScore}: `hot` is a claim that something is happening
       * right now, and a badge that lights up for every third row says nothing.
       */
      hotBurstScore: 6,
      /**
       * How long a trend is considered NEW after it first appeared, for the
       * client's badge. Past it the client shows the trend's age instead.
       */
      newTrendMaxAgeMs: 2 * 60 * 60 * 1000,
      /**
       * Gap tolerated when reconstructing when a trend STARTED. A term that
       * drops out of one or two batches and returns is the same run, not a new
       * one — trends hover around the reporting threshold, and treating every
       * dip as a fresh start would reset the age of a day-old story to zero and
       * relight its `new` badge. Three batch intervals.
       */
      onsetGapToleranceMs: 90 * 60 * 1000,
      /**
       * How far back the onset reconstruction looks. Bounds the history scan;
       * a run older than this reports its start clamped to the lookback, which
       * only affects the age label of a trend that has been running for a week
       * and is a bound the reader cannot mistake for a fresh start.
       */
      onsetLookbackMs: 7 * 24 * 60 * 60 * 1000,
      /** Trends stored per batch. Bounds the batch write and every read below it. */
      maxTrends: 30,
      /**
       * Representative authors kept per trend — the faces shown beside it. Small
       * on purpose: they are evidence that real accounts are behind the trend,
       * not a directory of them.
       */
      maxActors: 5,
    },

    /**
     * SUMMARIES — the one place a model is allowed to run, and only for trends
     * readers actually open.
     *
     * A trend's NAME is derived deterministically for every trend of every
     * batch (see `services/trending/trendLabeling.ts`). A summary is different:
     * it is prose explaining what happened, it is only worth anything on the
     * screen a reader lands on after pressing a trend, and it costs a
     * generation. Generating one per trend per batch would mean paying
     * continuously for text almost nobody reads — at 30 trends every 30
     * minutes, over a thousand generations a day whether or not a single person
     * opens one.
     *
     * So demand pays for it: the summary is generated the first time a trend
     * crosses {@link minViews} opens, ONCE per run, and served from storage
     * forever after.
     */
    summary: {
      /**
       * Opens a trend needs before its summary is generated.
       *
       * The threshold IS the cost control, and it is per-run rather than
       * per-batch: a trend that runs all day is summarised once, not
       * forty-eight times. Set it to a number a curious reader can reach and an
       * indifferent one cannot.
       */
      minViews: 25,
      /**
       * How long the view counter lives. Comfortably longer than a typical run
       * so the opens that accumulate over an evening still add up, and short
       * enough that a term returning weeks later starts counting afresh.
       */
      viewWindowMs: 48 * 60 * 60 * 1000,
      /**
       * Longest summary kept. Two sentences of context under a headline — past
       * this it stops being a caption and becomes an article nobody asked for.
       */
      maxLength: 280,
    },

    /**
     * LABELLING — turning a detected term into something a human recognises.
     *
     * A term is a retrieval key (`orioles`); a label is what the story is
     * (`Kremer Trade`). They are different strings for a good reason: the key
     * has to match what people wrote, and the label has to read like a headline.
     * Only the label is ever shown.
     */
    labeling: {
      /**
       * Terms sent for labelling per batch. Only terms that have never been
       * labelled are sent — an existing label is REUSED — so this bounds the
       * cost of a batch where many trends are new at once, which is exactly the
       * batch during which a big story breaks.
       */
      maxPerBatch: 12,
      /**
       * The category taxonomy offered to the labeller. Declared once in
       * `trending.ts` (with the matching type and the degrade-to-`other`
       * narrowing) and referenced here, so the list a prompt is built from and
       * the list a client can render can never drift apart.
       */
      categories: TREND_CATEGORIES,
    },
  },

  /** Videos (Reels) feed — metadata-backed filters (no runtime probing). */
  videosFeed: {
    /** Default minimum video duration in seconds for the ranked videos feed. */
    minDurationSec: 20,
    /** Default orientation filter — Reels surface is portrait-first. */
    defaultOrientation: 'portrait' as const,
  },

  // --- Cache TTLs (milliseconds) ---
  cache: {
    /** Per-feed-type TTLs for frontend caching */
    feedTtl: {
      for_you: 2000,
      following: 5000,
      explore: 30000,
      videos: 5000,
      media: 5000,
      saved: 10000,
      author: 10000,
      custom: 10000,
      hashtag: 15000,
      topic: 15000,
      trend: 15000,
      list: 10000,
      feedgen: 5000,
      trending: 15000,
      mutuals: 5000,
      friends_popular: 10000,
      friends_of_friends: 10000,
    } as Record<string, number>,
  },

  // --- User preference learning ---
  preferences: {
    weights: {
      like: 1.0,
      boost: 2.0,
      comment: 2.5,
      save: 1.5,
      share: 1.8,
      view: 0.2,
      skip: -0.5,
      hide: -2.0,
      mute: -3.0,
      block: -5.0,
    },
    maxPreferredAuthors: 100,
    maxPreferredTopics: 200,
    /**
     * Safety ceiling on the learned `preferredRegions` multiset. Regions are a
     * small, coarse space (country/zone codes), so this is just an upper bound a
     * roaming viewer can't blow past — not an expected trim point.
     */
    maxPreferredRegions: 20,
    decayDays: 30,
    viewTimeAlpha: 0.1,
    /**
     * How long a (viewer, post) view is remembered for de-duplication, so a
     * single post counts at most one view per viewer within this window even if
     * it is impressed repeatedly (re-scroll, refresh). 24h.
     */
    viewDedupeTtlMs: 24 * 60 * 60 * 1000,
    /**
     * Dwell (visible duration) below this threshold is treated as a SKIP — the
     * viewer scrolled past without engaging — and feeds the negative `skip`
     * preference signal. At/above it the impression feeds the positive `view`
     * signal. Mirrors the frontend's MIN_VISIBLE_MS qualification (1s) but kept
     * here as the authoritative server-side classification boundary.
     */
    dwellSkipThresholdMs: 2000,
    /**
     * Hard upper bound (ms) on a single impression's client-reported dwell before
     * it is folded into a post's rolling dwell average. Client telemetry is
     * UNTRUSTED — an unbounded `durationMs` (a backgrounded tab, a forged report)
     * would otherwise dominate the average and let a caller pump a post's
     * `dwellTime` ranking signal. Clamped in `FeedInteractionTracker` before
     * `recordDwell`. 5 minutes — generous for a genuine read, small enough that a
     * forged sample cannot swamp the mean.
     */
    maxDwellMs: 5 * 60 * 1000,
    /**
     * SURFACE-AWARE attribution. An engagement's meaning depends on WHERE it
     * happened. A like on the Videos/reels surface means "I like this VIDEO
     * content" (topic + post-type), NOT "I want to follow this author" — reels
     * are consumed by topic/algorithm, rarely by author. So on video-first
     * surfaces we DAMPEN author-affinity accrual and (slightly) AMPLIFY content
     * (post-type / topic) affinity. On every other surface attribution is full
     * (factor 1.0), preserving the prior behavior.
     */
    engagementContext: {
      /**
       * Feed-descriptor tokens treated as video-first surfaces. The canonical
       * reels feed is `videos`; matched case-insensitively and also by a
       * `videos|...` / `reels...` descriptor prefix so scoped variants count.
       */
      videoSurfaces: ['videos', 'reels'] as readonly string[],
      /**
       * Multiplier applied to AUTHOR-affinity accrual for an engagement that
       * originated on a video-first surface. 0.25 = a video like counts about a
       * quarter as much toward "follow this author" as a home/for-you like.
       */
      videoSurfaceAuthorAffinityFactor: 0.25,
      /**
       * Multiplier applied to CONTENT (post-type + topic) affinity accrual for a
       * video-surface engagement. 1.3 = a video like counts a bit MORE toward
       * "I like video content / these topics", reinforcing the surface's intent.
       */
      videoSurfaceContentBoost: 1.3,
    },
  },

  // --- Protocol constants ---
  protocol: {
    version: 1,
    nsidPrefix: 'mtn.social',
  },
} as const;

export type MtnConfigType = typeof MtnConfig;

/**
 * Classify an originating feed surface (a feed-descriptor string, e.g. `videos`,
 * `for_you`, `author|<id>`, `hashtag|<tag>`) as VIDEO-FIRST.
 *
 * Matching is case-insensitive and tolerant of scoped descriptors: a descriptor
 * is video-first when its leading token (before any `|`) equals, or starts with,
 * one of {@link MtnConfig.preferences.engagementContext.videoSurfaces}. So
 * `videos`, `VIDEOS`, `videos|trending`, and `reels` all count, while
 * `for_you`, `following`, `author|x`, `hashtag|video` do NOT.
 *
 * Returns `false` for an absent/blank surface so the default (no context) path
 * keeps the prior full-attribution behavior.
 */
export function isVideoSurface(surface: string | undefined | null): boolean {
  if (!surface || typeof surface !== 'string') return false;
  const token = surface.trim().toLowerCase().split('|')[0];
  if (!token) return false;
  return MtnConfig.preferences.engagementContext.videoSurfaces.some(
    (s) => token === s || token.startsWith(s),
  );
}
