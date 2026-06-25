/**
 * EndorsementSignalService — keeps Oxy's cross-app endorsement graph in sync
 * with Mention's curation membership (starter packs + account lists).
 *
 * Model: an owner who puts members into a starter pack or an account list is
 * ENDORSING those members. Mention reports this as desired-state edges
 * (`ownerId` endorses each `memberId`, scoped by the pack/list `_id`). Oxy owns
 * all reputation weighting — Mention sends the raw membership only.
 *
 * Desired-state + idempotent + self-healing:
 *  - {@link syncScope} recomputes the CURRENT member set for one pack/list and
 *    pushes it as `add` edges for that scope.
 *  - {@link syncScopeMembershipChange} captures members removed by an update
 *    before MongoDB loses them, persists those pending retractions in the
 *    outbox, and then re-syncs the scope.
 *  - When the scope is deleted, the deletion path captures the final member set
 *    and passes it explicitly to {@link syncScopeRemoval}.
 *
 * Reliability: every sync writes/refreshes an {@link EndorsementOutbox} row
 * FIRST, then attempts an immediate push. Success marks the row `sent`; failure
 * leaves it `pending` with backoff for the drain job ({@link flushOutbox}).
 */

import StarterPack from '../models/StarterPack';
import AccountList from '../models/AccountList';
import EndorsementOutbox, {
  getEndorsementNextAttempt,
  type EndorsementSource,
  type IEndorsementOutbox,
} from '../models/EndorsementOutbox';
import { oxySignalsClient, type OxySignalsClient, type EndorsementEdge } from './OxySignalsClient';
import { logger } from '../utils/logger';

/** Max outbox rows drained per flush page. */
const FLUSH_PAGE_SIZE = 200;

/** Resolved desired state for a single scope. */
interface ScopeState {
  ownerId: string;
  memberIds: string[];
}

export class EndorsementSignalService {
  constructor(private readonly signalsClient: OxySignalsClient = oxySignalsClient) {}

  /**
   * Load the owner + current members for a scope. Returns null when the source
   * document no longer exists (deleted) — the caller then handles retraction.
   */
  private async loadScopeState(source: EndorsementSource, sourceId: string): Promise<ScopeState | null> {
    if (source === 'starterPack') {
      const pack = await StarterPack.findById(sourceId)
        .select('ownerOxyUserId memberOxyUserIds')
        .lean();
      if (!pack) return null;
      return { ownerId: pack.ownerOxyUserId, memberIds: pack.memberOxyUserIds ?? [] };
    }
    const list = await AccountList.findById(sourceId)
      .select('ownerOxyUserId memberOxyUserIds')
      .lean();
    if (!list) return null;
    return { ownerId: list.ownerOxyUserId, memberIds: list.memberOxyUserIds ?? [] };
  }

  /**
   * Build the desired-state `add` edges for a scope: owner endorses each unique
   * member (excluding self-endorsement). Empty when there are no members.
   */
  private buildAddEdges(state: ScopeState, sourceId: string): EndorsementEdge[] {
    const unique = new Set(state.memberIds.filter((id) => id && id !== state.ownerId));
    return Array.from(unique).map((memberId) => ({
      ownerId: state.ownerId,
      memberId,
      op: 'add' as const,
      sourceId,
    }));
  }

  /** Build `remove` edges for captured, no-longer-current members. */
  private buildRemoveEdges(ownerId: string | undefined, memberIds: string[] | undefined, sourceId: string): EndorsementEdge[] {
    if (!ownerId) return [];
    const unique = new Set((memberIds ?? []).filter((id) => id && id !== ownerId));
    return Array.from(unique).map((memberId) => ({
      ownerId,
      memberId,
      op: 'remove' as const,
      sourceId,
    }));
  }

  /**
   * Upsert/re-arm the outbox row for a scope so it is `pending` and due now.
   * Returns the row's current attempt count (0 for a fresh row).
   */
  private async armOutbox(
    source: EndorsementSource,
    sourceId: string,
    removal?: { ownerId: string; memberIds: string[] },
  ): Promise<void> {
    const update: Record<string, unknown> = {
      $set: { status: 'pending', nextAttemptAt: new Date() },
      $setOnInsert: { attempts: 0 },
    };
    const removed = removal?.memberIds.filter((id) => id && id !== removal.ownerId) ?? [];
    if (removal && removed.length > 0) {
      update.$set = { ...(update.$set as Record<string, unknown>), pendingRemoveOwnerId: removal.ownerId };
      update.$addToSet = { pendingRemoveMemberIds: { $each: removed } };
    }
    await EndorsementOutbox.updateOne(
      { source, sourceId },
      update,
      { upsert: true },
    );
  }

  /** Mark a scope's outbox row as successfully sent. */
  private async markSent(source: EndorsementSource, sourceId: string): Promise<void> {
    await EndorsementOutbox.updateOne(
      { source, sourceId },
      {
        $set: { status: 'sent', attempts: 0, lastAttemptAt: new Date(), error: undefined },
        $unset: { pendingRemoveOwnerId: '', pendingRemoveMemberIds: '' },
      },
    );
  }

  /** Record a failed attempt with backoff, leaving the row pending. */
  private async markFailed(source: EndorsementSource, sourceId: string, error: unknown): Promise<void> {
    const row = await EndorsementOutbox.findOne({ source, sourceId }).select('attempts').lean();
    const attempts = (row?.attempts ?? 0) + 1;
    await EndorsementOutbox.updateOne(
      { source, sourceId },
      {
        $set: {
          status: 'pending',
          attempts,
          lastAttemptAt: new Date(),
          nextAttemptAt: getEndorsementNextAttempt(attempts),
          error: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }

  /**
   * Re-sync the desired endorsement state for one scope. Persists/arms the
   * outbox row first, then attempts an immediate push of the current member set.
   * Idempotent: re-running over an unchanged scope re-pushes the same edges
   * (Oxy treats re-adds as no-ops). When the scope no longer exists, the push is
   * empty and the row is marked sent (members are retracted via
   * {@link syncScopeRemoval} at the deletion call site, which has the member ids).
   */
  async syncScope(source: EndorsementSource, sourceId: string): Promise<void> {
    await this.armOutbox(source, sourceId);

    try {
      const [state, row] = await Promise.all([
        this.loadScopeState(source, sourceId),
        EndorsementOutbox.findOne({ source, sourceId })
          .select('pendingRemoveOwnerId pendingRemoveMemberIds')
          .lean<Pick<IEndorsementOutbox, 'pendingRemoveOwnerId' | 'pendingRemoveMemberIds'> | null>(),
      ]);
      const edges = [
        ...this.buildRemoveEdges(row?.pendingRemoveOwnerId, row?.pendingRemoveMemberIds, sourceId),
        ...(state ? this.buildAddEdges(state, sourceId) : []),
      ];
      await this.signalsClient.pushEndorsements(edges);
      await this.markSent(source, sourceId);
    } catch (error) {
      logger.warn(`[EndorsementSignal] sync failed for ${source}:${sourceId}; left pending:`, error);
      await this.markFailed(source, sourceId, error);
    }
  }

  /**
   * Re-sync a scope after a membership replacement/removal. The caller passes
   * the pre-save and post-save member lists so members that disappeared can be
   * emitted as durable `remove` edges even though they are no longer in MongoDB.
   */
  async syncScopeMembershipChange(
    source: EndorsementSource,
    sourceId: string,
    ownerId: string,
    previousMemberIds: string[],
    nextMemberIds: string[],
  ): Promise<void> {
    const next = new Set(nextMemberIds);
    const removed = Array.from(new Set(previousMemberIds.filter((id) => id && !next.has(id))));
    await this.armOutbox(source, sourceId, { ownerId, memberIds: removed });

    try {
      const [state, row] = await Promise.all([
        this.loadScopeState(source, sourceId),
        EndorsementOutbox.findOne({ source, sourceId })
          .select('pendingRemoveOwnerId pendingRemoveMemberIds')
          .lean<Pick<IEndorsementOutbox, 'pendingRemoveOwnerId' | 'pendingRemoveMemberIds'> | null>(),
      ]);
      const edges = [
        ...this.buildRemoveEdges(row?.pendingRemoveOwnerId ?? ownerId, row?.pendingRemoveMemberIds ?? removed, sourceId),
        ...(state ? this.buildAddEdges(state, sourceId) : []),
      ];
      await this.signalsClient.pushEndorsements(edges);
      await this.markSent(source, sourceId);
    } catch (error) {
      logger.warn(`[EndorsementSignal] membership sync failed for ${source}:${sourceId}; left pending:`, error);
      await this.markFailed(source, sourceId, error);
    }
  }

  /**
   * Retract endorsements for a scope being deleted. The deletion call site holds
   * the final member set (the source document is gone by drain time), so it is
   * passed explicitly. Pushes `remove` edges for `ownerId`→each member, then
   * clears the outbox row for the scope.
   */
  async syncScopeRemoval(
    source: EndorsementSource,
    sourceId: string,
    ownerId: string,
    memberIds: string[],
  ): Promise<void> {
    const unique = new Set(memberIds.filter((id) => id && id !== ownerId));
    const edges: EndorsementEdge[] = Array.from(unique).map((memberId) => ({
      ownerId,
      memberId,
      op: 'remove' as const,
      sourceId,
    }));

    // The source document is already deleted, so a desired-state re-sync (which
    // recomputes from the now-missing scope) cannot reconstruct the `remove`
    // edges. Retraction is therefore a best-effort push at deletion time; the
    // outbox row is cleared regardless so a stale `pending` row is never left
    // behind for a scope that no longer exists.
    try {
      await this.signalsClient.pushEndorsements(edges);
    } catch (error) {
      logger.warn(`[EndorsementSignal] removal push failed for ${source}:${sourceId} (best-effort):`, error);
    } finally {
      await EndorsementOutbox.deleteOne({ source, sourceId }).catch((err) => {
        logger.warn(`[EndorsementSignal] failed to clear outbox row for ${source}:${sourceId}:`, err);
      });
    }
  }

  /**
   * Drain pending outbox rows whose backoff has elapsed. Re-runs {@link syncScope}
   * for each (recomputing the current member set), so a row deleted between
   * enqueue and drain becomes a no-op push that marks the row sent. Bounded per
   * call; the periodic job re-invokes until the backlog clears.
   */
  async flushOutbox(): Promise<{ processed: number; sent: number; failed: number }> {
    const now = new Date();
    const rows = await EndorsementOutbox.find({
      status: 'pending',
      nextAttemptAt: { $lte: now },
    })
      .sort({ nextAttemptAt: 1 })
      .limit(FLUSH_PAGE_SIZE)
      .select('source sourceId')
      .lean();

    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      await this.syncScope(row.source, row.sourceId);
      const after = await EndorsementOutbox.findOne({ source: row.source, sourceId: row.sourceId })
        .select('status')
        .lean();
      if (after?.status === 'sent') sent += 1;
      else failed += 1;
    }

    if (rows.length > 0) {
      logger.info(`[EndorsementSignal] flushed ${rows.length} outbox rows: sent=${sent} failed=${failed}`);
    }
    return { processed: rows.length, sent, failed };
  }
}

export const endorsementSignalService = new EndorsementSignalService();
export default endorsementSignalService;
