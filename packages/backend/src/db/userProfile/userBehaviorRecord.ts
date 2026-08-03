/**
 * The shape one viewer's learned behaviour has once it is assembled out of
 * `user_behaviors` and its three preference child tables.
 *
 * This replaces the Mongoose `IUserBehavior` document interface outright. It is
 * a PLAIN object: no `Document`, no `markModified`, no `save`. Everything that
 * used to be expressed by marking a nested path modified is now expressed by the
 * repository diffing the record it handed out against the rows it loaded, so a
 * mutation that forgets a bookkeeping call cannot be silently dropped.
 *
 * The four negative-signal lists stay flat arrays because they ARE columns
 * (`text[]`) — they are read whole into the ranking context on every For You
 * request and never joined. `preferredAuthors` / `preferredTopics` /
 * `preferredRegions` look identical here but are child TABLES underneath; see
 * `userBehaviorRepository` for why that distinction matters at write time.
 */

/** One author the viewer has engaged with, with the breakdown behind the weight. */
export interface AuthorPreference {
  /** An Oxy account id. */
  authorId: string;
  /**
   * Accumulated engagement WEIGHT, not a tally — `+= Math.abs(learningWeight)`,
   * and the learning weights are fractional (`view` is 0.2, `save` 1.5).
   */
  interactionCount: number;
  lastInteractionAt: Date;
  interactionTypes: {
    likes: number;
    boosts: number;
    comments: number;
    saves: number;
    shares: number;
  };
  /** Calculated relationship strength, 0..1. */
  weight: number;
}

/** One topic the viewer has engaged with. */
export interface TopicPreference {
  /** The canonical topic slug, lowercased. */
  topic: string;
  /** An Oxy Topic-registry id. Absent on a preference learned before it existed. */
  topicId?: string;
  /** Accumulated engagement weight — fractional, exactly as for an author. */
  interactionCount: number;
  lastInteractionAt: Date;
  /** Derived from `interactionCount`, 0..1. */
  weight: number;
}

/** One coarse region the viewer's engagement came from. */
export interface RegionPreference {
  /** A coarse region/country code (`US`, `DE`). */
  region: string;
  /** Accumulated engagement weight for this region. */
  count: number;
  lastInteractionAt: Date;
}

/** The four fixed post-type buckets, as accumulated weights. */
export interface PostTypeAffinity {
  text: number;
  image: number;
  video: number;
  poll: number;
}

/** One viewer's complete learned behaviour. */
export interface UserBehaviorRecord {
  /** An Oxy account id. One record per user. */
  oxyUserId: string;
  preferredAuthors: AuthorPreference[];
  preferredTopics: TopicPreference[];
  preferredPostTypes: PostTypeAffinity;
  /** Hours 0..23 the viewer has been active in. */
  activeHours: number[];
  preferredLanguages: string[];
  preferredRegions: RegionPreference[];
  averageEngagementTime: number;
  skipRate: number;
  completionRate: number;
  hiddenAuthors: string[];
  mutedAuthors: string[];
  blockedAuthors: string[];
  hiddenTopics: string[];
  lastUpdated: Date;
  createdAt: Date;
  updatedAt: Date;
}
