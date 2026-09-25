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
