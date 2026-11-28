// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

export interface ShouldForceUntrackedOutboxSyncInput {
  outboxStatus?: string;
  /** The remote's own post total; `null` when it is unknown. */
  postsCount?: number | null;
  lastOutboxSyncAt?: Date;
  nowMs?: number;
  cooldownMs: number;
}

export function isWithinOutboxSyncCooldown(
  lastOutboxSyncAt: Date | undefined,
  cooldownMs: number,
  nowMs = Date.now(),
): boolean {
  const lastSyncMs = lastOutboxSyncAt?.getTime();
  return typeof lastSyncMs === 'number' && nowMs - lastSyncMs < cooldownMs;
}

export function shouldForceUntrackedOutboxSync({
  outboxStatus,
  postsCount,
  lastOutboxSyncAt,
  nowMs = Date.now(),
  cooldownMs,
}: ShouldForceUntrackedOutboxSyncInput): boolean {
  if (outboxStatus) return false;
  if (typeof postsCount !== 'number' || postsCount <= 0) return false;
  return !isWithinOutboxSyncCooldown(lastOutboxSyncAt, cooldownMs, nowMs);
}

/**
 * The backfill status of the actor's CURRENT outbox; a status recorded for an
 * outbox the actor no longer advertises says nothing about this one.
 */
export function currentOutboxBackfillStatus(actor: {
  outboxUrl?: string;
  outboxBackfill?: { outboxUrl?: string; status?: string };
}): string | undefined {
  if (!actor.outboxUrl || actor.outboxBackfill?.outboxUrl !== actor.outboxUrl) return undefined;
  return actor.outboxBackfill.status;
}

/** Whether the actor's current outbox is marked permanently unavailable. */
export function isOutboxMarkedUnavailable(
  actor: Parameters<typeof currentOutboxBackfillStatus>[0],
): boolean {
  return currentOutboxBackfillStatus(actor) === 'unavailable';
}
