/**
 * THE HUMAN HALF of the blocklist proposal loop: read the queue, and record what
 * was decided about it.
 *
 * THIS SCRIPT CANNOT BLOCK A DOMAIN, AND MUST NEVER LEARN HOW TO.
 *   Blocking is an entry in `connectors/activitypub/federationBlockPolicy` — a
 *   committed source file with a diff, an author and a review — or the
 *   `FEDERATION_BLOCKED_DOMAINS` emergency lever. Neither is reachable from a
 *   running process, and this script writes exactly one collection, the review
 *   queue (`BlocklistProposal`). ADOPTING a proposal means writing the entry by
 *   hand and committing it; the next sweep then sees the domain refused and
 *   closes the row. That asymmetry is the design, not an omission: the detection
 *   is automated so it does not rot, the decision is not, so another operator's
 *   moderation never becomes silently ours.
 *
 * WHY DECLINING IS A RECORDED ACTION
 *   The report only stays worth reading if it stops showing what has already
 *   been answered. A decline is therefore durable, attributed and reasoned — and
 *   it is simultaneously the only record anywhere of why we do NOT block a
 *   domain that several independent operators do. Both of those are worth a
 *   deliberate command.
 *
 * ACTIONS (`BLOCKLIST_PROPOSAL_ACTION`, default `list`)
 *   list      Print every proposal awaiting review. Read-only, no confirmation.
 *   sweep     Poll the published blocklists now and reconcile the queue. The
 *             scheduler does this weekly on its own; this is for when you want
 *             it before then.
 *   decline   Record that a domain was reviewed and rejected. Never proposed
 *             again unless reopened.
 *   reopen    Put a declined domain back in the queue.
 *
 * ENV
 *   BLOCKLIST_PROPOSAL_ACTION    list | sweep | decline | reopen
 *   BLOCKLIST_PROPOSAL_DOMAIN    the domain (decline, reopen)
 *   BLOCKLIST_PROPOSAL_REVIEWER  who is deciding (decline, reopen)
 *   BLOCKLIST_PROPOSAL_REASON    why (decline)
 *   CONFIRM_ADMIN_MUTATION       required for sweep/decline/reopen, set to
 *                                `reviewFederationBlocklistProposals`
 *
 * EXAMPLES (read-only first, always):
 *   bun packages/backend/dist/src/scripts/reviewFederationBlocklistProposals.js
 *
 *   BLOCKLIST_PROPOSAL_ACTION=decline \
 *   BLOCKLIST_PROPOSAL_DOMAIN=example.invalid \
 *   BLOCKLIST_PROPOSAL_REVIEWER=nate \
 *   BLOCKLIST_PROPOSAL_REASON="Bridge account, not spam — no category fits" \
 *   CONFIRM_ADMIN_MUTATION=reviewFederationBlocklistProposals \
 *   bun packages/backend/dist/src/scripts/reviewFederationBlocklistProposals.js
 */

import mongoose from 'mongoose';
import {
  declineProposal,
  listOpenProposals,
  renderProposalQueue,
  renderProposalReport,
  reopenProposal,
  runBlocklistProposalSweep,
} from '../services/federation/BlocklistProposalService';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';

const SCRIPT_NAME = 'reviewFederationBlocklistProposals';

type ReviewAction = 'list' | 'sweep' | 'decline' | 'reopen';

const ACTIONS = {
  list: 'list',
  sweep: 'sweep',
  decline: 'decline',
  reopen: 'reopen',
} as const satisfies Record<ReviewAction, ReviewAction>;

/** Reject an unknown action outright — a typo must not silently become `list`. */
function parseAction(value: string | undefined): ReviewAction {
  const requested = (value ?? 'list').trim().toLowerCase();
  const action = Object.values(ACTIONS).find((candidate) => candidate === requested);
  if (action) return action;
  throw new Error(
    `[${SCRIPT_NAME}] unknown BLOCKLIST_PROPOSAL_ACTION "${requested}";`
    + ` expected one of ${Object.values(ACTIONS).join(', ')}`,
  );
}

/** A required env value, or a message naming exactly what is missing. */
function required(name: string, action: ReviewAction): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`[${SCRIPT_NAME}] ${action} needs ${name}`);
  return value;
}

async function runList(): Promise<void> {
  const pending = await listOpenProposals();
  if (pending.length === 0) {
    logger.info('[reviewFederationBlocklistProposals] nothing awaits review');
    return;
  }

  logger.info('[reviewFederationBlocklistProposals] proposals awaiting review', {
    pending: pending.length,
  });
  for (const line of renderProposalQueue(pending, new Date())) {
    logger.info('[reviewFederationBlocklistProposals] queue', { line });
  }
}

async function runSweep(): Promise<void> {
  const result = await runBlocklistProposalSweep({ trigger: 'manual' });

  for (const line of renderProposalReport(result)) {
    logger.info('[reviewFederationBlocklistProposals] report', { line });
  }

  // A poll that could not reach a verdict produces an empty list that reads
  // exactly like "there is nothing to block". It must not exit 0.
  assertAdminRunComplete(SCRIPT_NAME, { unusableRun: result.ok ? 0 : 1 });
}

async function main(): Promise<void> {
  const action = parseAction(process.env.BLOCKLIST_PROPOSAL_ACTION);
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    // `list` reads and writes nothing, so it stays usable without ceremony.
    // Everything else writes the queue and asks for the script name first.
    assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun: action === 'list' });

    await mongoose.connect(mongoUri, { dbName });

    if (action === 'list') {
      await runList();
    } else if (action === 'sweep') {
      await runSweep();
    } else if (action === 'decline') {
      const declined = await declineProposal({
        domain: required('BLOCKLIST_PROPOSAL_DOMAIN', action),
        decidedBy: required('BLOCKLIST_PROPOSAL_REVIEWER', action),
        reason: required('BLOCKLIST_PROPOSAL_REASON', action),
      });
      logger.info('[reviewFederationBlocklistProposals] declined', {
        domain: declined.domain,
        decidedBy: declined.decidedBy,
      });
    } else {
      const reopened = await reopenProposal(
        required('BLOCKLIST_PROPOSAL_DOMAIN', action),
        required('BLOCKLIST_PROPOSAL_REVIEWER', action),
      );
      logger.info('[reviewFederationBlocklistProposals] reopened', { domain: reopened.domain });
    }
  } catch (error) {
    logger.error('[reviewFederationBlocklistProposals] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
    await mongoose.disconnect().catch((disconnectError: unknown) => {
      logger.warn(
        '[reviewFederationBlocklistProposals] error during mongoose.disconnect()',
        disconnectError,
      );
    });
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (the Redis client and BullMQ
  // handles pulled in through the federation helpers) keep the event loop alive,
  // so a one-shot would otherwise sit RUNNING forever after the work completed.
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[reviewFederationBlocklistProposals] unhandled failure', error);
      process.exit(1);
    });
}

export default main;
