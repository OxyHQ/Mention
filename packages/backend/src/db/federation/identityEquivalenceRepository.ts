/**
 * The ONLY module that knows cross-network identity equivalence is three tables:
 * the CLAIMS each actor publishes, the LINKS those claims prove, and the
 * evidence SNAPSHOT taken when a link was decided.
 *
 * Everything above it — `connectors/identity`, the reconciliation one-shot —
 * reads and writes whole {@link CrossNetworkIdentityClaim}s and
 * {@link IdentityLinkRecord}s.
 *
 * ## Two invariants this module exists to hold
 *
 * 1. **An actor's claim set is REPLACED, never appended to.** That is the entire
 *    reversal mechanism: an account that stops asserting its counterpart has no
 *    rows here after the next refresh, and `proveCrossNetworkEquivalence` then
 *    finds nothing to prove. Appending would let a link outlive its evidence
 *    forever, and on a recyclable handle outlive the PERSON it was about.
 * 2. **A pair is one row whichever side arrives first.** Every write goes
 *    through `identityPairKey`, so `(instagram, threads)` and
 *    `(threads, instagram)` address the same row and a concurrent second ingest
 *    collides on the unique index rather than writing a twin the first would
 *    never find.
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import {
  federatedIdentityClaims,
  federatedIdentityLinkEvidence,
  federatedIdentityLinks,
} from '../schema/federation';
import { identityPairKey } from '../../connectors/identityEquivalence/crossNetworkIdentityPolicy';
import type { CrossNetworkIdentityClaim } from '../../connectors/identityEquivalence/identityClaims';

/** One `federated_identity_links` row, as consumers read it. */
export interface IdentityLinkRecord {
  id: string;
  identityA: string;
  identityB: string;
  actorUriA?: string;
  actorUriB?: string;
  status: 'linked' | 'pending_reconciliation' | 'revoked';
  oxyUserId?: string;
  reason: string;
  linkedAt?: Date;
  revokedAt?: Date;
  revokedReason?: string;
}

type LinkRow = typeof federatedIdentityLinks.$inferSelect;

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function assembleLink(row: LinkRow): IdentityLinkRecord {
  return {
    id: row.id,
    identityA: row.identityA,
    identityB: row.identityB,
    actorUriA: optional(row.actorUriA),
    actorUriB: optional(row.actorUriB),
    status: row.status,
    oxyUserId: optional(row.oxyUserId),
    reason: row.reason,
    linkedAt: optional(row.linkedAt),
    revokedAt: optional(row.revokedAt),
    revokedReason: optional(row.revokedReason),
  };
}

/**
 * Replace everything one actor claims, in one transaction.
 *
 * An EMPTY list is a meaningful call, not a no-op to optimize away: it is what
 * an actor that stopped asserting its counterpart produces, and dropping the
 * rows is precisely how the link built on them becomes unprovable.
 */
export async function replaceIdentityClaims(
  subjectActorUri: string,
  claims: readonly CrossNetworkIdentityClaim[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(federatedIdentityClaims)
      .where(eq(federatedIdentityClaims.subjectActorUri, subjectActorUri));
    if (claims.length === 0) return;
    await tx.insert(federatedIdentityClaims).values(
      claims.map((claim) => ({
        subjectActorUri,
        subject: claim.subject.trim().toLowerCase(),
        target: claim.target.trim().toLowerCase(),
        kind: claim.kind,
        source: claim.source,
      })),
    );
  });
}

/**
 * The `subject_actor_uri` an ATTESTED claim is filed under.
 *
 * Deliberately NOT an actor URI, and that is the whole mechanism. A derived
 * claim belongs to the actor that publishes it, and
 * {@link replaceIdentityClaims} wipes an actor's whole set on every refresh —
 * which is exactly what makes a withdrawn assertion revoke its link. An attested
 * claim is not the actor's to withdraw: it comes from the network OPERATOR,
 * through a first-party interface, and an actor refresh must not be able to
 * delete it. Filing it under a synthetic per-PAIR key puts it outside every
 * actor's set by construction, rather than relying on some future caller
 * remembering to exclude it.
 *
 * Per-pair rather than per-operator so that removing one attestation cannot take
 * another down with it.
 */
export function attestationSubjectKey(identityA: string, identityB: string): string {
  const [left, right] = identityPairKey(identityA, identityB);
  return `attestation:${left}|${right}`;
}

/**
 * File a first-party attestation that two network identities are one person.
 *
 * Written in BOTH directions. One would be enough for `evaluateEquivalence`,
 * which accepts a first-party claim from either side — but which side is
 * readable depends on which actor happens to be resolving, and a record that
 * answers from only one end is a record that behaves differently depending on
 * arrival order. Symmetric costs one row and removes the question.
 *
 * Idempotent: re-attesting the same pair updates the two rows rather than
 * multiplying them, because `(subject_actor_uri, target, kind)` is unique.
 */
export async function recordAttestedIdentityClaims(
  params: { identityA: string; identityB: string; source: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const a = params.identityA.trim().toLowerCase();
  const b = params.identityB.trim().toLowerCase();
  const subjectActorUri = attestationSubjectKey(a, b);

  await db
    .insert(federatedIdentityClaims)
    .values([
      { subjectActorUri, subject: a, target: b, kind: 'first-party-link' as const, source: params.source },
      { subjectActorUri, subject: b, target: a, kind: 'first-party-link' as const, source: params.source },
    ])
    .onConflictDoUpdate({
      target: [
        federatedIdentityClaims.subjectActorUri,
        federatedIdentityClaims.target,
        federatedIdentityClaims.kind,
      ],
      set: { source: params.source, observedAt: new Date() },
    });
}

/** Withdraw an attestation. Returns how many rows went — 0, or 2. */
export async function removeAttestedIdentityClaims(
  params: { identityA: string; identityB: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const removed = await db
    .delete(federatedIdentityClaims)
    .where(eq(
      federatedIdentityClaims.subjectActorUri,
      attestationSubjectKey(params.identityA, params.identityB),
    ))
    .returning({ id: federatedIdentityClaims.id });
  return removed.length;
}

/** Every attestation on file — the reconciliation report's inventory. */
export async function listAttestedIdentityClaims(
  db: DatabaseOrTransaction = getDb(),
): Promise<CrossNetworkIdentityClaim[]> {
  const rows = await db
    .select()
    .from(federatedIdentityClaims)
    .where(eq(federatedIdentityClaims.kind, 'first-party-link'));
  return rows.map((row) => ({
    subject: row.subject,
    subjectActorUri: row.subjectActorUri,
    target: row.target,
    kind: row.kind,
    source: row.source,
  }));
}

/** Every claim published by the actors currently stored under an identity. */
export async function findIdentityClaimsBySubject(
  subject: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CrossNetworkIdentityClaim[]> {
  const rows = await db
    .select()
    .from(federatedIdentityClaims)
    .where(eq(federatedIdentityClaims.subject, subject.trim().toLowerCase()));
  return rows.map((row) => ({
    subject: row.subject,
    subjectActorUri: row.subjectActorUri,
    target: row.target,
    kind: row.kind,
    source: row.source,
  }));
}

/**
 * Every claim ABOUT an identity — "who says they are also this account?".
 *
 * The reverse of {@link findIdentityClaimsBySubject}, and needed because a
 * `first-party-link` can be recorded against the counterpart while the actor
 * being resolved publishes nothing at all. Searching only forwards would make
 * that evidence invisible from one of the two sides, so which actor happened to
 * refresh last would decide whether a proven pair is found.
 */
export async function findIdentityClaimsByTarget(
  target: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CrossNetworkIdentityClaim[]> {
  const rows = await db
    .select()
    .from(federatedIdentityClaims)
    .where(eq(federatedIdentityClaims.target, target.trim().toLowerCase()));
  return rows.map((row) => ({
    subject: row.subject,
    subjectActorUri: row.subjectActorUri,
    target: row.target,
    kind: row.kind,
    source: row.source,
  }));
}

/** Drop every claim published by these actors — the purge path's counterpart. */
export async function deleteIdentityClaimsByActorUris(
  actorUris: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (actorUris.length === 0) return 0;
  const deleted = await db
    .delete(federatedIdentityClaims)
    .where(inArray(federatedIdentityClaims.subjectActorUri, [...actorUris]))
    .returning({ id: federatedIdentityClaims.id });
  return deleted.length;
}

/** The link row for a pair, whichever order the caller names it in, or `null`. */
export async function findIdentityLink(
  identityA: string,
  identityB: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<IdentityLinkRecord | null> {
  const [left, right] = identityPairKey(identityA, identityB);
  const [row] = await db
    .select()
    .from(federatedIdentityLinks)
    .where(and(
      eq(federatedIdentityLinks.identityA, left),
      eq(federatedIdentityLinks.identityB, right),
    ))
    .limit(1);
  return row ? assembleLink(row) : null;
}

/** Every link one identity takes part in, whichever side of the pair it is on. */
export async function findIdentityLinksFor(
  identity: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<IdentityLinkRecord[]> {
  const needle = identity.trim().toLowerCase();
  const rows = await db
    .select()
    .from(federatedIdentityLinks)
    .where(or(
      eq(federatedIdentityLinks.identityA, needle),
      eq(federatedIdentityLinks.identityB, needle),
    ));
  return rows.map(assembleLink);
}

/** What {@link recordIdentityLink} writes. Identities are ordered for the caller. */
export interface IdentityLinkWrite {
  identityA: string;
  identityB: string;
  actorUriA?: string;
  actorUriB?: string;
  status: IdentityLinkRecord['status'];
  /** Required when `status` is `'linked'`, forbidden otherwise (a CHECK enforces it). */
  oxyUserId?: string;
  reason: string;
  revokedReason?: string;
  evidence: readonly CrossNetworkIdentityClaim[];
}

/**
 * Write the verdict for a pair, replacing whatever was there.
 *
 * The evidence snapshot is replaced along with the row: a link re-decided on new
 * claims must not keep showing the ones it no longer rests on. The old rows go
 * by the `ON DELETE cascade`'s sibling — an explicit delete inside the same
 * transaction — because the link row itself is UPDATED rather than replaced, so
 * the cascade never fires.
 *
 * `identityA`/`identityB` are re-ordered here rather than trusted from the
 * caller: one call site spelling a pair the other way round is the whole failure
 * this table's unique index cannot catch on its own.
 */
export async function recordIdentityLink(
  write: IdentityLinkWrite,
  db: DatabaseOrTransaction = getDb(),
): Promise<IdentityLinkRecord> {
  const [left, right] = identityPairKey(write.identityA, write.identityB);
  // The actor URIs travel WITH their identity, so re-ordering the pair must
  // re-order them too — otherwise a link would name the wrong actor as the
  // source of each side's evidence, which is the one thing this row is for.
  const swapped = left !== write.identityA.trim().toLowerCase();
  const actorUriA = (swapped ? write.actorUriB : write.actorUriA) ?? null;
  const actorUriB = (swapped ? write.actorUriA : write.actorUriB) ?? null;

  const now = new Date();
  const values = {
    identityA: left,
    identityB: right,
    actorUriA,
    actorUriB,
    status: write.status,
    oxyUserId: write.status === 'linked' ? (write.oxyUserId ?? null) : null,
    reason: write.reason,
    linkedAt: write.status === 'linked' ? now : null,
    revokedAt: write.status === 'revoked' ? now : null,
    revokedReason: write.revokedReason ?? null,
    updatedAt: now,
  };

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(federatedIdentityLinks)
      .values(values)
      .onConflictDoUpdate({
        target: [federatedIdentityLinks.identityA, federatedIdentityLinks.identityB],
        set: {
          actorUriA: values.actorUriA,
          actorUriB: values.actorUriB,
          status: values.status,
          oxyUserId: values.oxyUserId,
          reason: values.reason,
          linkedAt: values.linkedAt,
          revokedAt: values.revokedAt,
          revokedReason: values.revokedReason,
          updatedAt: values.updatedAt,
        },
      })
      .returning();

    await tx
      .delete(federatedIdentityLinkEvidence)
      .where(eq(federatedIdentityLinkEvidence.linkId, row.id));
    if (write.evidence.length > 0) {
      await tx.insert(federatedIdentityLinkEvidence).values(
        write.evidence.map((claim) => ({
          linkId: row.id,
          subjectActorUri: claim.subjectActorUri,
          subject: claim.subject.trim().toLowerCase(),
          target: claim.target.trim().toLowerCase(),
          kind: claim.kind,
          source: claim.source,
        })),
      );
    }
    return assembleLink(row);
  });
}

/** The evidence a link was decided on, as it stood at that moment. */
export async function loadIdentityLinkEvidence(
  linkId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CrossNetworkIdentityClaim[]> {
  const rows = await db
    .select()
    .from(federatedIdentityLinkEvidence)
    .where(eq(federatedIdentityLinkEvidence.linkId, linkId));
  return rows.map((row) => ({
    subject: row.subject,
    subjectActorUri: row.subjectActorUri,
    target: row.target,
    kind: row.kind,
    source: row.source,
  }));
}

/** Links in a given state — how the reconciliation report enumerates them. */
export async function listIdentityLinks(
  status: IdentityLinkRecord['status'],
  limit = 500,
  db: DatabaseOrTransaction = getDb(),
): Promise<IdentityLinkRecord[]> {
  const rows = await db
    .select()
    .from(federatedIdentityLinks)
    .where(eq(federatedIdentityLinks.status, status))
    .orderBy(sql`${federatedIdentityLinks.updatedAt} desc`)
    .limit(limit);
  return rows.map(assembleLink);
}
