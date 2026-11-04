import {
  findTransportHandoff,
  firstAcceptedKeyedFollowAt,
  holdsKeylessPostBefore,
  type TransportHandoff,
  writeTransportHandoffOnce,
} from '../../db/federation/transportHandoffRepository';
import {
  keyedMirrorHosts,
  keylessMirrorHosts,
  mirrorPostTime,
  mirrorTransportOf,
} from '../../utils/federation/mirrorTransports';
import { getRemoteHost } from '../shared/url';

/**
 * ONE ACCOUNT, TWO TRANSPORTS, NO OVERLAP: THE HANDOFF.
 *
 * mastox.eu (KEYLESS) copies X accounts under its own ids; its `published` is when
 * it crawled the tweet, never earlier than the tweet itself (0 of 695 measured
 * pairs). bird.makeup (KEYED) carries the same accounts with the tweet id as the
 * status id, so a tweet's time is exact (the id is a snowflake). Nothing in a
 * mastox post names its tweet, so the two copies of one tweet can never be
 * matched. Instead each account's timeline is split at ONE instant, the handoff
 * H, by the time the tweet was written:
 *
 *  - before H the account's posts are mastox's: a mastox post is kept only when
 *    its crawl time is before H, which proves its tweet was written before H too;
 *  - from H on they are bird.makeup's: a bird.makeup post written before H is
 *    not stored, because that period is mastox's.
 *
 * A tweet therefore has exactly one transport it may be stored from — zero
 * duplicates, decided from times alone.
 *
 * H is written once per account, when Mention first holds an accepted follow of
 * the keyed transport (the Accept's time), and never moved. If Mention held no
 * keyless post of the account by then, H is "none": nothing of that period was
 * mastox's, so bird.makeup takes everything and mastox nothing.
 *
 * Replies: mastox carries none (0 of 6,686 stored posts), bird.makeup does. So a
 * reply is always bird.makeup's and never mastox's, whatever its time — it cannot
 * be duplicated, and an old reply a thread needs is not lost.
 *
 * What is lost, and its bound: a tweet written shortly before H that mastox had
 * not crawled by H — mastox's crawl lag (p99 466 s, max 1,127 s on the 522
 * measured tweets of the last 30 days; longer while mastox is stalled) — and a
 * bird.makeup copy of an older tweet (a quote, a boosted original) that mastox
 * never stored.
 *
 * Generic: the transports come from the mirror registry. Any keyless mirror of a
 * network with a keyed mirror behaves the same, with no new code.
 */

/** A post's transport and the times the rule reads. */
export interface HandoffSubject {
  keyed: boolean;
  /** Keyed: when the upstream post was written. Keyless: when the transport crawled it. */
  time: Date | undefined;
  isReply: boolean;
}

/** Whether the post belongs to the transport that delivered it, given the account's handoff. Pure. */
export function belongsToTransport(
  subject: HandoffSubject,
  handoff: TransportHandoff | undefined,
): boolean {
  // No keyed subscription yet: each transport is a source, as before.
  if (!handoff) return true;
  if (subject.isReply) return subject.keyed;
  if (handoff.at === null) return subject.keyed;
  if (subject.keyed) return subject.time === undefined || subject.time >= handoff.at;
  return subject.time !== undefined && subject.time < handoff.at;
}

/**
 * The account's handoff: the stored one, or — when Mention holds an accepted
 * follow of a keyed transport of the account and none is stored yet — the one
 * that follow sets, written now. Undefined while the account has no keyed
 * subscription, or when its network has no keyless transport.
 */
export async function transportHandoff(
  networkAcct: string,
  network: Parameters<typeof keyedMirrorHosts>[0],
): Promise<TransportHandoff | undefined> {
  const keyless = keylessMirrorHosts(network);
  if (keyless.length === 0) return undefined;
  const stored = await findTransportHandoff(networkAcct);
  if (stored) return stored;
  const acceptedAt = await firstAcceptedKeyedFollowAt(networkAcct, keyedMirrorHosts(network));
  if (!acceptedAt) return undefined;
  const hadKeyless = await holdsKeylessPostBefore(networkAcct, keyless, acceptedAt);
  return writeTransportHandoffOnce(networkAcct, hadKeyless ? acceptedAt : null);
}

/**
 * Why a Note from a mirror is not stored under the handoff rule, or null when it
 * is (or the author is no mirror of a network with a keyless transport).
 */
export async function transportHandoffRefusal(
  author: { uri: string; domain?: string | null; networkAcct?: string | null },
  note: { activityId: string; published: Date | undefined; isReply: boolean },
): Promise<string | null> {
  const transport = mirrorTransportOf(author.domain ?? getRemoteHost(author.uri) ?? '');
  if (!transport || !author.networkAcct) return null;
  const handoff = await transportHandoff(author.networkAcct, transport.network);
  const time = transport.keyed
    ? (mirrorPostTime(note.activityId) ?? note.published)
    : note.published;
  return belongsToTransport({ keyed: transport.keyed, time, isReply: note.isReply }, handoff)
    ? null
    : transport.keyed
      ? 'keyed-before-handoff'
      : 'keyless-after-handoff';
}

/**
 * Write the handoff of the account `actor` is a keyed transport of, when Mention
 * has just accepted a follow of it — so the instant is the Accept's.
 */
export async function recordHandoffOnAccept(actor: {
  domain?: string | null;
  uri: string;
  networkAcct?: string | null;
}): Promise<void> {
  const transport = mirrorTransportOf(actor.domain ?? getRemoteHost(actor.uri) ?? '');
  if (!transport?.keyed || !actor.networkAcct) return;
  await transportHandoff(actor.networkAcct, transport.network);
}
