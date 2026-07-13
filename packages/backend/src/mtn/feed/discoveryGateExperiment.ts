/**
 * Discovery-gate A/B experiment (Phase 7).
 *
 * Deterministically splits viewers into two cohorts by hashing their `oxyUserId`
 * so the For You discovery gate can be validated online before it is enforced for
 * everyone:
 *   - `gate-on`  → the gate is ENFORCED (objective-junk discovery candidates are
 *     dropped), exactly as it behaves outside the experiment.
 *   - `gate-off` → the gate is MEASURED-ONLY (its rejections are still counted via
 *     `feed_discovery_gated_total{shadow="true"}`, but nothing is dropped), so the
 *     cohort keeps seeing the pre-gate feed.
 *
 * Because the bucket is a PURE, STABLE function of the id, an offline analysis (or
 * the eval harness's online mode) can recompute each viewer's bucket and join it
 * to their `FeedInteraction` rows to compare skip-rate / report-rate /
 * engagement-per-impression between cohorts — no bucket label needs to ride on the
 * online metrics.
 *
 * The experiment is OFF by default and gated entirely by the `FOR_YOU_DISCOVERY_GATE_AB`
 * env flag (`on`/`true`/`1` to enable), reusing the same env-resolved,
 * per-request `ctx`-threaded plumbing the discovery gate and Phase-2b signals
 * already use — no new flag channel.
 */

import { createHash } from 'crypto';
import type { DiscoveryGateBucket } from './engine/types';

export type { DiscoveryGateBucket };

/** Whether the discovery-gate A/B experiment is enabled via `FOR_YOU_DISCOVERY_GATE_AB`. */
export function isDiscoveryGateExperimentEnabled(): boolean {
  const raw = process.env.FOR_YOU_DISCOVERY_GATE_AB?.trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1';
}

/**
 * Deterministically bucket a viewer by hashing their `oxyUserId`. Stable across
 * requests and processes (SHA-256 of the id, first-byte parity → an even 50/50
 * split), and PURE — the same id always maps to the same bucket, which is what
 * makes the offline cohort comparison possible.
 */
export function bucketForDiscoveryGate(userId: string): DiscoveryGateBucket {
  const firstByte = createHash('sha256').update(userId).digest()[0];
  return firstByte % 2 === 0 ? 'gate-on' : 'gate-off';
}

/**
 * Resolve the discovery-gate bucket for a viewer, or `undefined` when the
 * experiment is disabled or there is no viewer (anonymous). `undefined` means "no
 * experiment override" — the gate then follows the global shadow config.
 */
export function resolveDiscoveryGateBucket(
  userId: string | undefined,
): DiscoveryGateBucket | undefined {
  if (!userId || !isDiscoveryGateExperimentEnabled()) {
    return undefined;
  }
  return bucketForDiscoveryGate(userId);
}
