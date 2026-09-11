import { and, eq, gte, isNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import { normalizeMultilineText } from '@oxy.so/core';
import { getDb } from '../db/postgres';
import { postEquivalenceMembers, posts } from '../db/schema/posts';
import { postContentVariants, postMedia } from '../db/schema/postContent';
import { federatedActors } from '../db/schema/federation';
import {
  createCluster,
  dissolveCluster,
  findClusterById,
  findClusterByPostId,
  removeClusterMember,
  setPreferredMember,
  type EquivalenceClusterRecord,
  type EquivalenceMemberWrite,
} from '../db/posts/postEquivalenceRepository';
import { findCrossNetworkPair } from '../connectors/identityEquivalence';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';

/**
 * ONE PIECE OF WRITING, TWO OBJECTS — AND WHY THAT IS NOT THE SAME QUESTION AS
 * "ARE THESE TWO ACCOUNTS ONE PERSON?".
 *
 * Proving that `@zuck@instagram.com` and `@zuck@threads.net` are one person says
 * nothing about their POSTS. A person with two accounts writes different things
 * on them most of the time, and collapsing everything they publish would be a
 * far worse bug than the duplicate it set out to fix. So post equivalence is its
 * own concept, with its own evidence, and a proven identity is a PRECONDITION
 * for it rather than a reason.
 *
 * ## Every source object survives. Only the card collapses.
 *
 * The Instagram object and the Threads object keep their own permalinks,
 * protocol ids, edits, deletes, replies, likes, boosts and moderation state,
 * because they genuinely are two objects and the reader may need either. What
 * changes is that feed, profile and search surfaces render the cluster's
 * PREFERRED member and skip the rest — through a SQL predicate, so a page of 20
 * rows is still 20 cards.
 *
 * ## The evidence hierarchy, strongest first
 *
 *   `declared`        the source SAYS SO — an explicit canonical/original
 *                     relation on the object itself. Deterministic; nothing else
 *                     is checked once it holds.
 *   `shared-media-id` both objects name the same first-party media asset.
 *   `canonical-link`  one object carries the other's permalink as its source.
 *   `fingerprint`     the conservative FALLBACK, and the only tier that can be
 *                     wrong. It demands ALL of: the same Oxy person through a
 *                     PROVEN cross-network identity link; two networks that are
 *                     a reviewed pair; publication inside a narrow window;
 *                     exact normalized text where text exists; the same media
 *                     count and types; and a deterministic media-equality
 *                     signal. Any one missing and it refuses.
 *
 * ## What may NEVER create a cluster
 *
 * Two different people posting the same photo. Similar text. A close perceptual
 * hash — nothing here computes one, deliberately, because "close" is exactly the
 * signal that produces confident false positives. Matching usernames. The same
 * author repeating themselves hours or days later. A false positive here
 * attributes one post's engagement, replies and provenance to another post; a
 * missed collapse shows a reader two cards. Those are not comparable, and every
 * threshold below is set on that asymmetry.
 *
 * ## Text-only posts get a tighter window than anything else
 *
 * A person can intentionally write the same sentence twice, and short posts
 * collide across an account's own history far more often than media does. So a
 * text-only pair has minutes rather than half an hour, and an empty body can
 * never be matched at all — every empty string is equal to every other one.
 */

/** `metrics` label for a refusal, so "why is nothing collapsing?" is answerable. */
const EQUIVALENCE_DECISION_METRIC = 'post_equivalence_decision_total';

/**
 * How far apart two variants of one cross-post may be published.
 *
 * Meta's own cross-posting publishes both within seconds; a person doing it by
 * hand takes longer. Thirty minutes covers the manual case without reaching into
 * "the same author posted something similar later today", which is the collision
 * this bound exists to exclude rather than to tolerate.
 */
export const CROSSPOST_WINDOW_MS = Number.parseInt(
  process.env.CROSSPOST_WINDOW_MS ?? '',
  10,
) || 30 * 60 * 1000;

/**
 * The same bound for a pair with NO media, where the only evidence is that two
 * strings match.
 *
 * Deliberately far tighter. "Good morning" is a post somebody makes on both
 * accounts every day of their life, and at half an hour the fallback would
 * cluster two of them roughly whenever the two ingests landed near each other.
 */
export const CROSSPOST_TEXT_ONLY_WINDOW_MS = Number.parseInt(
  process.env.CROSSPOST_TEXT_ONLY_WINDOW_MS ?? '',
  10,
) || 5 * 60 * 1000;

/** What happened to one detection attempt. */
export interface CrosspostDecision {
  outcome: 'clustered' | 'joined' | 'refused' | 'not-applicable';
  /** A stable code — logs, metrics and the reconciliation report read it. */
  reason: string;
  clusterId?: string;
}

/** Everything {@link detectCrosspostEquivalence} is told about a freshly-stored post. */
export interface CrosspostDetectionInput {
  postId: string;
  /**
   * URLs the SOURCE OBJECT declared as this post's original — an AS2 `url` Link
   * with `rel` containing `canonical`, or an equivalent first-party relation.
   *
   * Supplied by the ingest rather than re-read here, because only the ingest
   * holds the raw document. Absent for every object that declares nothing, which
   * is most of them, and the `declared` tier then simply does not fire.
   */
  declaredOriginalUrls?: readonly string[];
}

/** The post fields every tier reads. */
interface EquivalenceCandidate {
  id: string;
  oxyUserId: string;
  /** The authoring actor's NETWORK identity domain — see {@link networkDomainSql}. */
  networkDomain: string;
  createdAt: Date;
  federationUrl: string | null;
  /** The primary rendition's body, normalized for comparison. */
  text: string;
  media: CandidateMedia[];
}

interface CandidateMedia {
  type: string;
  /** The origin URL as the remote served it, before the cache rewrote anything. */
  remoteUrl: string | null;
  mediaId: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
}

function decision(outcome: CrosspostDecision['outcome'], reason: string, clusterId?: string): CrosspostDecision {
  metrics.incrementCounter(EQUIVALENCE_DECISION_METRIC, 1, { outcome, reason });
  return { outcome, reason, clusterId };
}

/**
 * A media URL reduced to the asset it names.
 *
 * Meta's CDN URLs carry signed, expiring query parameters that differ on every
 * fetch and between the two apps, so the raw URLs of one asset never match. What
 * DOES survive is the path. Query and fragment are dropped and the host with
 * them: the same asset is served from different CDN hosts to the two apps, and
 * keeping the host would make two spellings of one file look like two files.
 *
 * Returns `undefined` for anything that is not a usable identifier — which is
 * the point of the length floor. A path ending in `image.jpg` or `1.png` names
 * an asset on thousands of sites, and matching on it would cluster unrelated
 * posts with total confidence.
 */
export function sharedMediaIdentifier(remoteUrl: string | null): string | undefined {
  if (!remoteUrl) return undefined;
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return undefined;
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const terminal = segments[segments.length - 1];
  if (!terminal) return undefined;
  const token = terminal.replace(/\.[a-z0-9]{1,5}$/i, '');
  // Long enough to be an asset id rather than a word, and carrying at least one
  // digit — the two properties every first-party media identifier has and no
  // generic filename does.
  if (token.length < 16 || !/\d/.test(token)) return undefined;
  return token.toLowerCase();
}

/**
 * The NETWORK a federated post came from, as SQL over the joined actor row.
 *
 * Not `posts.federation_actor_uri`'s host, and the difference is the whole
 * point: an Instagram post reaches us through `kilogram.makeup`, so the actor
 * URI's host names the bridge rather than the network. The authoring actor row
 * already holds the answer — `network_acct` for a re-labelled bridged actor
 * (`zuck@instagram.com`), and `domain` for everything else, which is the same
 * two-shape rule `findIdentityOwnerActor` reads — so it is taken from there.
 *
 * Reading the bridge host instead would put both variants of a Meta cross-post
 * on hosts that are trivially different (`kilogram.makeup` vs `threads.net`) and
 * so pass the "different network" test for the wrong reason, while ALSO failing
 * `findCrossNetworkPair`, which is keyed on identity domains. The pair lookup
 * would then refuse every real cross-post — a silent, total no-op.
 */
function networkDomainSql(): SQL<string | null> {
  return sql<string | null>`coalesce(
    nullif(split_part(${federatedActors.networkAcct}, '@', 2), ''),
    ${federatedActors.domain}
  )`;
}

/** Load everything the tiers read about one post, or `null` when it is gone. */
async function loadCandidate(postId: string): Promise<EquivalenceCandidate | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: posts.id,
      oxyUserId: posts.oxyUserId,
      networkDomain: networkDomainSql(),
      createdAt: posts.createdAt,
      federationUrl: posts.federationUrl,
      status: posts.status,
      boostOf: posts.boostOf,
    })
    .from(posts)
    .leftJoin(federatedActors, eq(federatedActors.uri, posts.federationActorUri))
    .where(eq(posts.id, postId))
    .limit(1);
  if (!row || row.status !== 'published' || row.boostOf !== null) return null;
  if (!row.oxyUserId || !row.networkDomain || !row.createdAt) return null;

  const [variant] = await db
    .select({ body: postContentVariants.body })
    .from(postContentVariants)
    .where(and(eq(postContentVariants.postId, postId), eq(postContentVariants.position, 0)))
    .limit(1);

  const media = await db
    .select({
      type: postMedia.type,
      remoteUrl: postMedia.remoteUrl,
      mediaId: postMedia.mediaId,
      width: postMedia.width,
      height: postMedia.height,
      sizeBytes: postMedia.sizeBytes,
    })
    .from(postMedia)
    .where(eq(postMedia.postId, postId))
    .orderBy(postMedia.position);

  return {
    id: row.id,
    oxyUserId: row.oxyUserId,
    networkDomain: row.networkDomain,
    createdAt: row.createdAt,
    federationUrl: row.federationUrl,
    text: normalizeMultilineText(variant?.body ?? '').trim(),
    media,
  };
}

/**
 * The sibling posts worth comparing against: same Oxy person, a DIFFERENT
 * network, inside the widest window any tier allows, not already clustered.
 *
 * "Same Oxy person" is doing the heavy lifting and is not a convenience. Two
 * accounts only share an Oxy user after the within-network bridged merge or the
 * cross-network equivalence layer has proved they are one person — so "the same
 * content from two different people" cannot reach this function at all, rather
 * than being rejected by a later check somebody might reorder.
 */
async function findSiblingIds(candidate: EquivalenceCandidate): Promise<string[]> {
  const since = new Date(candidate.createdAt.getTime() - CROSSPOST_WINDOW_MS);
  const until = new Date(candidate.createdAt.getTime() + CROSSPOST_WINDOW_MS);
  const rows = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .leftJoin(federatedActors, eq(federatedActors.uri, posts.federationActorUri))
    .leftJoin(postEquivalenceMembers, eq(postEquivalenceMembers.postId, posts.id))
    .where(and(
      eq(posts.oxyUserId, candidate.oxyUserId),
      ne(posts.id, candidate.id),
      ne(networkDomainSql(), candidate.networkDomain),
      eq(posts.status, 'published'),
      isNull(posts.boostOf),
      gte(posts.createdAt, since),
      lte(posts.createdAt, until),
      isNull(postEquivalenceMembers.id),
    ))
    .orderBy(posts.createdAt)
    .limit(20);
  return rows.map((row) => row.id);
}

/** The evidence linking two candidates, strongest first, or `undefined`. */
function classifyPair(
  a: EquivalenceCandidate,
  b: EquivalenceCandidate,
  declaredOriginalUrls: readonly string[],
): { confidence: EquivalenceClusterRecord['confidence']; evidence: string } | undefined {
  // The two networks must be a REVIEWED pair. Sharing an Oxy user is not enough
  // on its own: the bridged merge also produces one, and two copies of the same
  // X account arriving through two bridges are the same OBJECT rather than a
  // cross-post — clustering those would collapse a duplicate that the identity
  // layer is already responsible for.
  if (!findCrossNetworkPair(a.networkDomain, b.networkDomain)) return undefined;

  const declared = declaredOriginalUrls.find(
    (url) => b.federationUrl !== null && sameUrl(url, b.federationUrl),
  );
  if (declared) return { confidence: 'declared', evidence: `declared-original:${declared}` };

  // Everything below the author's own declaration additionally needs the two
  // bodies to be COMPATIBLE. Shared media is strong evidence that one upload
  // reached two apps; it is not evidence that the same thing was WRITTEN twice,
  // and a person re-posting their own photo with a new thought has published two
  // pieces of writing. It is also what makes an edit able to end a cluster: a
  // Threads copy that grows three paragraphs the Instagram caption never had
  // stops being compatible, and `reevaluateCluster` splits it back out.
  if (!textsCompatible(a, b)) return undefined;

  const sharedAsset = sharedMediaAsset(a, b);
  if (sharedAsset) return { confidence: 'shared-media-id', evidence: `shared-media-id:${sharedAsset}` };

  const canonical = canonicalLink(a, b);
  if (canonical) return { confidence: 'canonical-link', evidence: `canonical-link:${canonical}` };

  return fingerprint(a, b);
}

/**
 * Whether two bodies can be the same piece of writing.
 *
 * Equal after normalization, or one of them EMPTY — a caption on one network and
 * a bare image post on the other is an ordinary cross-post, and demanding
 * equality there would refuse most real ones. Anything else is two different
 * things said about the same picture.
 *
 * Deliberately not a similarity score. "Mostly the same" is the input that turns
 * a conservative rule into a confident false positive, and the threshold would
 * have to be defended in both directions with no data to defend it from.
 */
function textsCompatible(a: EquivalenceCandidate, b: EquivalenceCandidate): boolean {
  if (a.text === b.text) return true;
  return a.text.length === 0 || b.text.length === 0;
}

/** Whether two URLs name the same resource once transient query state is dropped. */
function sameUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.host.toLowerCase() === b.host.toLowerCase()
      && a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
}

/** A first-party media identifier both posts carry, or `undefined`. */
function sharedMediaAsset(a: EquivalenceCandidate, b: EquivalenceCandidate): string | undefined {
  if (a.media.length === 0 || a.media.length !== b.media.length) return undefined;
  const theirs = new Set(
    b.media.map((item) => sharedMediaIdentifier(item.remoteUrl)).filter((id): id is string => Boolean(id)),
  );
  if (theirs.size === 0) return undefined;
  // EVERY item must match, not merely one. One shared asset inside two different
  // carousels is one reused photo, which is a thing people do on purpose.
  const ours = a.media.map((item) => sharedMediaIdentifier(item.remoteUrl));
  if (ours.some((id) => id === undefined || !theirs.has(id))) return undefined;
  return ours[0];
}

/** Either post naming the other's permalink as its source, or `undefined`. */
function canonicalLink(a: EquivalenceCandidate, b: EquivalenceCandidate): string | undefined {
  if (b.federationUrl && a.text.includes(b.federationUrl)) return b.federationUrl;
  if (a.federationUrl && b.text.includes(a.federationUrl)) return a.federationUrl;
  return undefined;
}

/**
 * The fallback, which refuses far more often than it fires.
 *
 * Read the conditions as a single conjunction: publication inside the window
 * (tighter with no media), identical normalized text when there IS text, the
 * same media count and the same types in the same order, and — because nothing
 * above is a content identity — a deterministic media-equality signal from
 * dimensions and byte size. A pair missing any one of them is not clustered and
 * is not clustered "with lower confidence" either: there is no such thing here.
 */
function fingerprint(
  a: EquivalenceCandidate,
  b: EquivalenceCandidate,
): { confidence: EquivalenceClusterRecord['confidence']; evidence: string } | undefined {
  const gap = Math.abs(a.createdAt.getTime() - b.createdAt.getTime());
  const textOnly = a.media.length === 0 && b.media.length === 0;
  if (gap > (textOnly ? CROSSPOST_TEXT_ONLY_WINDOW_MS : CROSSPOST_WINDOW_MS)) return undefined;

  // An empty body is equal to every other empty body, so it can never be the
  // evidence. With no media either, there is nothing left to compare at all.
  if (a.text !== b.text) return undefined;
  if (textOnly && a.text.length === 0) return undefined;
  if (textOnly) {
    return { confidence: 'fingerprint', evidence: `identical-text:${gap}ms` };
  }

  if (a.media.length !== b.media.length) return undefined;
  for (let i = 0; i < a.media.length; i += 1) {
    const ours = a.media[i];
    const theirs = b.media[i];
    if (ours.type !== theirs.type) return undefined;
    // Dimensions and byte size, both present and both equal. A missing value is
    // a refusal rather than a pass: "we could not tell" is not "they matched",
    // and treating it as one is how a fingerprint check becomes a text check
    // wearing a media check's name.
    if (!ours.width || !ours.height || ours.width !== theirs.width || ours.height !== theirs.height) {
      return undefined;
    }
    if (!ours.sizeBytes || ours.sizeBytes !== theirs.sizeBytes) return undefined;
  }

  return { confidence: 'fingerprint', evidence: `identical-text-and-media:${gap}ms` };
}

/**
 * Which variant a reader is shown, decided DETERMINISTICALLY.
 *
 * Arrival order is deliberately not part of it: the same set of members must
 * always choose the same representative, or a re-evaluation after an edit or a
 * deletion could silently swap which post a permalink-sharing reader sees.
 *
 *   1. a member the evidence names as the declared original;
 *   2. the richer media — more items first, then more total pixels;
 *   3. the earliest publication, which is the one that was written first;
 *   4. the lowest id, so the answer is total.
 */
export function preferredVariant(
  members: readonly { postId: string; evidence: string }[],
  candidates: ReadonlyMap<string, EquivalenceCandidate>,
): string {
  const pixels = (candidate: EquivalenceCandidate | undefined): number =>
    (candidate?.media ?? []).reduce((total, item) => total + (item.width ?? 0) * (item.height ?? 0), 0);

  return [...members]
    .sort((left, right) => {
      const declaredLeft = left.evidence.startsWith('declared-original:') ? 0 : 1;
      const declaredRight = right.evidence.startsWith('declared-original:') ? 0 : 1;
      if (declaredLeft !== declaredRight) return declaredLeft - declaredRight;

      const a = candidates.get(left.postId);
      const b = candidates.get(right.postId);
      const mediaCount = (b?.media.length ?? 0) - (a?.media.length ?? 0);
      if (mediaCount !== 0) return mediaCount;
      const area = pixels(b) - pixels(a);
      if (area !== 0) return area;

      const published = (a?.createdAt.getTime() ?? 0) - (b?.createdAt.getTime() ?? 0);
      if (published !== 0) return published;
      return left.postId < right.postId ? -1 : 1;
    })[0].postId;
}

/**
 * Decide whether a freshly-stored post is a cross-post of something we already
 * hold, and cluster it if so.
 *
 * Never throws. A failure here must not fail an ingest — the post is stored and
 * visible either way, and the worst outcome of a miss is the duplicate card this
 * exists to remove. The reconciliation one-shot picks up anything skipped.
 */
export async function detectCrosspostEquivalence(
  input: CrosspostDetectionInput,
): Promise<CrosspostDecision> {
  try {
    const candidate = await loadCandidate(input.postId);
    if (!candidate) return decision('not-applicable', 'post-not-eligible');
    if (await findClusterByPostId(candidate.id)) {
      return decision('not-applicable', 'already-clustered');
    }

    const siblingIds = await findSiblingIds(candidate);
    if (siblingIds.length === 0) return decision('refused', 'no-sibling-in-window');

    const declared = input.declaredOriginalUrls ?? [];
    for (const siblingId of siblingIds) {
      // eslint-disable-next-line no-await-in-loop
      const sibling = await loadCandidate(siblingId);
      if (!sibling) continue;
      const match = classifyPair(candidate, sibling, declared);
      if (!match) continue;

      const candidates = new Map([[candidate.id, candidate], [sibling.id, sibling]]);
      const members: EquivalenceMemberWrite[] = [
        {
          postId: candidate.id,
          networkDomain: candidate.networkDomain,
          preferred: false,
          evidence: match.evidence,
        },
        {
          postId: sibling.id,
          networkDomain: sibling.networkDomain,
          preferred: false,
          evidence: match.evidence,
        },
      ];
      const preferredId = preferredVariant(members, candidates);
      for (const member of members) member.preferred = member.postId === preferredId;

      // eslint-disable-next-line no-await-in-loop
      const clusterId = await createCluster(match.confidence, members);
      logger.info('[Equivalence] cross-post variants collapsed into one feed item', {
        cluster: clusterId,
        confidence: match.confidence,
        evidence: match.evidence,
        members: members.map((member) => `${member.networkDomain}:${member.postId}`),
        preferred: preferredId,
      });
      return decision('clustered', match.confidence, clusterId);
    }

    return decision('refused', 'no-sufficient-evidence');
  } catch (err) {
    logger.warn('[Equivalence] cross-post detection failed', { post: input.postId, err });
    return decision('not-applicable', 'detection-failed');
  }
}

/**
 * Re-check a cluster after one of its posts changed or went away.
 *
 * Two things make a cluster wrong after the fact, and both are ordinary: an EDIT
 * that makes one variant materially different from the other — a Threads post
 * that grows three paragraphs the Instagram caption never had is no longer the
 * same piece of writing — and a DELETE that leaves one member behind. A cluster
 * that has stopped being true must stop collapsing, and it must do so by making
 * the hidden post visible again rather than by leaving a card pointing at
 * nothing.
 *
 * Members whose evidence was DETERMINISTIC are re-checked too. A declared
 * original stays declared through an edit, so the tier that created the cluster
 * is the tier that re-decides it — which is why this re-runs `classifyPair`
 * rather than trusting the stored confidence.
 */
export async function reevaluateCluster(clusterId: string): Promise<void> {
  try {
    const cluster = await findClusterById(clusterId);
    if (!cluster) return;

    const loaded = new Map<string, EquivalenceCandidate>();
    for (const member of cluster.members) {
      // eslint-disable-next-line no-await-in-loop
      const candidate = await loadCandidate(member.postId);
      if (candidate) loaded.set(member.postId, candidate);
    }

    const surviving = cluster.members.filter((member) => loaded.has(member.postId));
    if (surviving.length < 2) {
      // One variant left (or none): there is nothing to collapse, and whatever
      // survives must be visible. Dissolving rather than keeping a one-member
      // cluster also means the surviving post can be clustered again later.
      await dissolveCluster(clusterId);
      logger.info('[Equivalence] cluster dissolved; fewer than two variants remain', {
        cluster: clusterId,
      });
      return;
    }

    // Re-decide every member against the one the evidence prefers. A member that
    // no longer matches is SPLIT OUT and made visible again rather than the
    // whole cluster being torn down — the remaining variants are still each
    // other's cross-posts.
    const anchorId = preferredVariant(surviving, loaded);
    const anchor = loaded.get(anchorId)!;
    let removed = 0;
    for (const member of surviving) {
      if (member.postId === anchorId) continue;
      const other = loaded.get(member.postId)!;
      const declared = member.evidence.startsWith('declared-original:')
        ? [member.evidence.slice('declared-original:'.length)]
        : [];
      if (classifyPair(anchor, other, declared)) continue;
      // eslint-disable-next-line no-await-in-loop
      await removeClusterMember(clusterId, member.postId);
      removed += 1;
      logger.info('[Equivalence] variant split out of its cluster; it no longer matches', {
        cluster: clusterId,
        post: member.postId,
      });
    }

    if (surviving.length - removed < 2) {
      await dissolveCluster(clusterId);
      return;
    }
    await setPreferredMember(clusterId, anchorId);
  } catch (err) {
    logger.warn('[Equivalence] cluster re-evaluation failed', { cluster: clusterId, err });
  }
}

/** Re-check the cluster a post belongs to, if any. The edit path's entry point. */
export async function reevaluateClusterForPost(postId: string): Promise<void> {
  const cluster = await findClusterByPostId(postId).catch(() => null);
  if (cluster) await reevaluateCluster(cluster.id);
}

/** Re-check several clusters — the post-deletion repair. */
export async function reevaluateClusters(clusterIds: readonly string[]): Promise<void> {
  for (const clusterId of clusterIds) {
    // eslint-disable-next-line no-await-in-loop
    await reevaluateCluster(clusterId);
  }
}

/**
 * Classify a pair WITHOUT writing anything — the reconciliation one-shot's
 * dry-run reads this so its report and the live path can never disagree about
 * what would have been clustered.
 */
export async function classifyStoredPair(
  postId: string,
  otherPostId: string,
  declaredOriginalUrls: readonly string[] = [],
): Promise<{ confidence: EquivalenceClusterRecord['confidence']; evidence: string } | undefined> {
  const [a, b] = await Promise.all([loadCandidate(postId), loadCandidate(otherPostId)]);
  if (!a || !b) return undefined;
  return classifyPair(a, b, declaredOriginalUrls);
}

/** The sibling posts a stored post would be compared against — dry-run only. */
export async function findCrosspostSiblings(postId: string): Promise<string[]> {
  const candidate = await loadCandidate(postId);
  return candidate ? findSiblingIds(candidate) : [];
}
