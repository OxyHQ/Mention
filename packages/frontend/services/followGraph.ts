/**
 * Mention's corner of the user-owned follow graph (`/v2/follows`) — which turns
 * out to be almost nothing, and that is the correct outcome.
 *
 * The graph is Oxy's and the follow belongs to the USER, not to Mention: a topic
 * followed here is followed everywhere, and switching it off here leaves it
 * followed everywhere else.
 *
 * ## Why there is no namespace claim and no kind registration here
 *
 * `docs/FOLLOWS.md` opens with three onboarding calls — claim a namespace,
 * register your kinds, resolve a target — and Mention makes exactly ONE of them.
 * The only thing it lets a person follow through this graph is a TOPIC, and a
 * topic is Oxy's: migration `0016_follow_graph.sql` seeds `oxy.topic` as a
 * PLATFORM kind with a NULL `application_id`, already declaring
 * `{verb: follow, reverse: aggregate, federated: false}`. So the kind exists
 * before Mention asks, its privacy posture is decided, and Mention could not
 * change it if it wanted to — the registry refuses a kind inside a namespace the
 * caller does not own.
 *
 * A channel is the other thing one might expect here, and it is deliberately
 * absent: a channel is an Oxy ACCOUNT, and account follows still live in the
 * older account-follow graph that the Following feed reads. Wiring one here
 * would give a channel two independent follow states that disagree the first
 * time anybody pressed either. Channels join when account follows themselves
 * move onto `/v2/follows`.
 */

/**
 * The platform kind for a topic. Seeded by the API, owned by nobody — named here
 * rather than inlined so the one place that has to agree with the migration is
 * findable.
 */
export const OXY_TOPIC_KIND = 'oxy.topic';

/**
 * The Oxy IDENTITY apex, deliberately not `OXY_BASE_URL` from `config.ts`.
 *
 * A target's URI is an identity, not an endpoint anything fetches — it is the
 * string two applications independently arrive at so they land on ONE row. Built
 * from a per-deployment base it would differ between a staging build and a
 * production one, and the same topic would become two rows and two parallel
 * follows for one person. The registry hardcodes this same apex for the
 * `oxy.user` shape, for the same reason.
 */
const OXY_IDENTITY_ORIGIN = 'https://oxy.so';

/**
 * A topic, addressed the way its owner addresses it.
 *
 * Topics are Oxy's — `GET /topics` in the Mention backend proxies to the Oxy API
 * and `TopicData` is an `@oxyhq/core` type — so an Oxy URI is the honest
 * identity and any other Oxy surface resolves the SAME row rather than opening a
 * second one. A URI invented per-app is what quietly gives every user two
 * parallel follows of one thing.
 *
 * Keyed on the SLUG, which is what every other surface already treats as the
 * durable identity: the feed descriptor is `topic|<slug>` and the lookup is
 * `getBySlug`.
 */
export function topicFollowUri(slug: string): string {
  return `${OXY_IDENTITY_ORIGIN}/topics/${encodeURIComponent(slug.trim().toLowerCase())}`;
}
