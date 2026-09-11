/**
 * Record — or withdraw — a FIRST-PARTY attestation that two network identities
 * are one person.
 *
 * ## What this is for, and what it deliberately is not
 *
 * `connectors/identityEquivalence` links two identities on a reviewed pair when
 * each one independently asserts the other on its own actor. It also accepts a
 * stronger, rarer kind of evidence: a `first-party-link`, which is the network
 * OPERATOR stating the linkage rather than either account vouching for the
 * other. That kind was defined, storable and evaluated, and until now NOTHING
 * could write one — the only writer of claims was the actor-derived path. This
 * is the missing door.
 *
 * **It is not a Meta integration, and does not pretend to be one.** Meta's own
 * account-linkage data is reachable only through a credentialed, approved
 * interface; a client written against an API nobody here can call would be
 * guesswork wearing the shape of authority, which is precisely the failure the
 * bridge policy calls "a rule invented from a half-remembered profile shape". So
 * this takes the attestation as an INPUT from whoever holds that access, records
 * it with provenance, and leaves the question of where it came from to the
 * operator who types it in — and to `source`, which is stored verbatim and shown
 * in the reconciliation report.
 *
 * ## Why an attestation is not filed under an actor
 *
 * A derived claim belongs to the actor that publishes it, and the actor refresh
 * REPLACES that actor's whole claim set — which is what makes a withdrawn
 * assertion revoke its link on the next pass. An attestation is not the actor's
 * to withdraw, so it is filed under a synthetic per-pair key
 * (`attestationSubjectKey`) that is outside every actor's set by construction.
 * It goes when an operator removes it here, and not before.
 *
 * ## What it refuses
 *
 * The pair must be one `CROSS_NETWORK_IDENTITY_POLICY` reviewed — an attestation
 * cannot invent a relationship between two networks nobody reviewed, because the
 * reviewed list is the moderation judgement and this is an evidence channel, not
 * a way around it. Both identities must be well-formed `<handle>@<domain>`, and
 * they must be different.
 *
 * ## Reversible, by design
 *
 * `REMOVE=true` withdraws the attestation. The link it supported is not deleted
 * by that: `reconcileCrossNetworkIdentity` re-proves every pair from the claims
 * that exist at the time, so the next refresh of either actor finds nothing left
 * to prove and revokes the link through the ordinary path, with its evidence
 * snapshot intact.
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `true`; only `DRY_RUN=false` writes.
 *  2. `assertAdminMutationAllowed` refuses a mutating run until the operator
 *     names the script back.
 *  3. Idempotent: re-attesting the same pair updates the two rows in place.
 *
 * Runnable as a Fargate one-shot (DRY_RUN first):
 *   SUBJECT=zuck@instagram.com TARGET=zuck@threads.net \
 *     SOURCE="Meta connected-accounts export, 2026-09-11, ticket OPS-1234" \
 *     bun packages/backend/dist/src/scripts/recordAttestedIdentityLink.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=recordAttestedIdentityLink \
 *     SUBJECT=… TARGET=… SOURCE=… \
 *     bun packages/backend/dist/src/scripts/recordAttestedIdentityLink.js
 */

import { connectPostgres } from '../db/postgres';
import {
  listAttestedIdentityClaims,
  recordAttestedIdentityClaims,
  removeAttestedIdentityClaims,
} from '../db/federation/identityEquivalenceRepository';
import {
  findCrossNetworkPair,
  identityDomainOf,
} from '../connectors/identityEquivalence';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'recordAttestedIdentityLink';

/** Why an attestation was refused. Stable strings — the report reads them. */
export type AttestationRefusal =
  | 'malformed-identity'
  | 'same-identity'
  | 'pair-not-reviewed'
  | 'missing-source';

export interface AttestationOutcome {
  applied: boolean;
  refusal?: AttestationRefusal;
  /** How many claim rows the run wrote or removed. Zero on a dry run. */
  rows: number;
}

export interface AttestationInput {
  identityA: string;
  identityB: string;
  /**
   * What proves it, verbatim — an export name, a ticket, an interface and a
   * date. Stored and surfaced, because "why are these two accounts one person?"
   * has to be answerable months later by someone who was not here.
   */
  source: string;
  remove?: boolean;
  dryRun?: boolean;
}

/**
 * Validate and apply one attestation. The CALLER owns the connection lifecycle,
 * so a test can run it in-process against real rows.
 */
export async function recordAttestedIdentityLink(
  input: AttestationInput,
): Promise<AttestationOutcome> {
  const dryRun = input.dryRun ?? true;
  const a = input.identityA.trim().toLowerCase();
  const b = input.identityB.trim().toLowerCase();

  const domainA = identityDomainOf(a);
  const domainB = identityDomainOf(b);
  if (!domainA || !domainB) return { applied: false, refusal: 'malformed-identity', rows: 0 };
  if (a === b) return { applied: false, refusal: 'same-identity', rows: 0 };

  // An attestation is an EVIDENCE channel, never a way around the reviewed list:
  // deciding that two networks can describe one person is the moderation
  // judgement, and no amount of first-party data changes which pairs were
  // reviewed.
  if (!findCrossNetworkPair(domainA, domainB)) {
    return { applied: false, refusal: 'pair-not-reviewed', rows: 0 };
  }

  // Removal needs no source — there is nothing left to explain.
  if (!input.remove && input.source.trim().length === 0) {
    return { applied: false, refusal: 'missing-source', rows: 0 };
  }

  if (dryRun) {
    logger.info(`[${SCRIPT_NAME}] would ${input.remove ? 'withdraw' : 'record'} an attestation`, {
      identityA: a,
      identityB: b,
      ...(input.remove ? {} : { source: input.source }),
    });
    return { applied: false, rows: 0 };
  }

  if (input.remove) {
    const rows = await removeAttestedIdentityClaims({ identityA: a, identityB: b });
    logger.info(`[${SCRIPT_NAME}] attestation withdrawn`, { identityA: a, identityB: b, rows });
    return { applied: true, rows };
  }

  await recordAttestedIdentityClaims({ identityA: a, identityB: b, source: input.source });
  logger.info(`[${SCRIPT_NAME}] attestation recorded`, {
    identityA: a,
    identityB: b,
    source: input.source,
  });
  return { applied: true, rows: 2 };
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  const remove = (process.env.REMOVE ?? 'false') === 'true';
  const identityA = process.env.SUBJECT ?? '';
  const identityB = process.env.TARGET ?? '';
  const source = process.env.SOURCE ?? '';

  if (!identityA || !identityB) {
    throw new Error(
      `[${SCRIPT_NAME}] SUBJECT and TARGET are required, each a <handle>@<network-domain> identity `
      + '(e.g. SUBJECT=zuck@instagram.com TARGET=zuck@threads.net).',
    );
  }

  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();

  const outcome = await recordAttestedIdentityLink({ identityA, identityB, source, remove, dryRun });
  if (outcome.refusal) {
    throw new Error(`[${SCRIPT_NAME}] refused: ${outcome.refusal}`);
  }

  const onFile = await listAttestedIdentityClaims();
  logger.info(`[${SCRIPT_NAME}] complete`, {
    dryRun,
    remove,
    rows: outcome.rows,
    attestationsOnFile: onFile.length / 2,
  });
}

if (require.main === module) {
  main()
    .then(async () => {
      await closeAdminScriptResources();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(1);
    });
}
