import { CrowdSource } from '@oxy.so/crowdsource';
import { config } from '../../config';
import { canAuthenticateAsService } from '../../runtime/serviceIdentity';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';

/**
 * The CrowdSource client, built once and only where it can authenticate.
 *
 * There is deliberately almost nothing here. The SDK already owns the base URL,
 * the timeouts, the bounded per-attempt retries, the idempotency key and the
 * error classification, and a wrapper that re-implemented any of them would be a
 * second answer to a question that has one.
 *
 * ## Mention holds no CrowdSource key
 *
 * It presents the Oxy service token it already has — the same one the media
 * store, the capability authority and the inference client use — and CrowdSource
 * resolves the tenant from the Oxy application that token names (oxy ADR 0026,
 * and `oxyApplicationAuth.ts` on the CrowdSource side). Nothing is issued by
 * hand, stored in a parameter store or rotated by a person.
 *
 * `applicationId` therefore appears nowhere, as before, but for a new reason:
 * the token names an OXY application, so the client asks CrowdSource which
 * tenant that is, once, and remembers the answer.
 */

let client: CrowdSource | null = null;
let unavailable: string | null = null;

/**
 * The client, or `undefined` where Mention cannot authenticate.
 *
 * `undefined` rather than a throw: that is the normal state of a local checkout,
 * and a report filed there must still be stored. The delivery worker is what
 * notices there is nowhere to send it — the durable row is never gated.
 *
 * The reason is logged once. Once, because the alternative is a line per
 * delivery attempt per report, which buries the cause it is meant to reveal.
 */
export function getCrowdSourceClient(): CrowdSource | undefined {
  if (client) return client;
  if (unavailable !== null) return undefined;

  if (!canAuthenticateAsService()) {
    unavailable = 'this process cannot obtain an Oxy service token';
    logger.info('[CrowdSource] client not built', { reason: unavailable });
    return undefined;
  }

  client = new CrowdSource({
    /**
     * Asked once per request attempt. `getServiceToken()` caches and re-mints on
     * expiry, which is exactly the contract the SDK documents for this option.
     *
     * The SERVICE client, not the per-request one: it is the instance this
     * process configured with its own credentials, and the one that falls back
     * to attesting the task role when there are none.
     */
    oxyToken: () => getServiceOxyClient().getServiceToken(),
    ...(config.crowdSource.baseUrl === undefined
      ? {}
      : { baseUrl: config.crowdSource.baseUrl }),
  });

  /**
   * Resolve the tenant once, in the background, so a missing BINDING is visible
   * at boot rather than on the first report.
   *
   * A token this deployment can mint for an Oxy application nobody bound to a
   * CrowdSource tenant authenticates nothing, and that failure is otherwise
   * indistinguishable from "no reports yet". Nothing waits on this: the client
   * is usable, the SDK resolves the same promise for its own calls, and a
   * rejection here is the log line, not a broken boot.
   */
  void Promise.resolve(client.applicationId).then(
    (applicationId) => {
      logger.info('[CrowdSource] client ready', { applicationId });
    },
    (error: unknown) => {
      logger.error('[CrowdSource] client built but the tenant did not resolve', {
        reason: error instanceof Error ? error.message : String(error),
      });
    },
  );

  return client;
}

/**
 * Whether reports may LEAVE this deployment.
 *
 * Stricter than having a client, on purpose. A report that is delivered with no
 * way to receive the decision is worse than one held locally: the case is
 * judged, the outcome is signed to an endpoint nothing verifies, and the gap is
 * invisible until somebody wonders why nothing ever came back. So the webhook
 * secret — the one thing here that is genuinely configuration — gates the
 * delivery loop.
 *
 * It does not gate the client. Community notes are a request and its answer,
 * with no webhook in the path, and holding them for a secret they never use
 * would be gating the wrong thing.
 */
export function canDeliverToCrowdSource(): boolean {
  return Boolean(config.crowdSource.webhookSecret) && getCrowdSourceClient() !== undefined;
}

/** Test hook. Production builds the client once and keeps it for the process. */
export function resetCrowdSourceClient(): void {
  client = null;
  unavailable = null;
}
