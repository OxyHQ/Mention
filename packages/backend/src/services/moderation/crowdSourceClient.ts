import { CrowdSource } from '@oxyhq/crowdsource';
import { config } from '../../config';
import { logger } from '../../utils/logger';

/**
 * The CrowdSource client, built once and only when configured.
 *
 * There is deliberately almost nothing here. The SDK already owns the base URL,
 * the timeouts, the bounded per-attempt retries, the idempotency key and the
 * error classification, and a wrapper that re-implemented any of them would be a
 * second answer to a question that has one. What Mention adds is exactly two
 * things: the client is absent until the integration is switched on, and it is
 * built once rather than per delivery.
 *
 * `applicationId` appears nowhere — the client reads it off the service key, and
 * there is no option, field or parameter through which one could be passed.
 */

let client: CrowdSource | null = null;
let configurationError: string | null = null;

/**
 * The client, or `undefined` when the integration is not configured.
 *
 * `undefined` rather than a throw: `CROWDSOURCE_ENABLED=false` is the normal state
 * of a local checkout and of every deployment before rollout, and a report filed
 * there must still be stored. The delivery worker is what notices there is nowhere
 * to send it.
 *
 * A MISCONFIGURED client — a malformed service key — is a different thing and is
 * logged once at error level. Logged once because the alternative is one line per
 * delivery attempt per report, which buries the cause it is meant to reveal.
 */
export function getCrowdSourceClient(): CrowdSource | undefined {
  if (!config.crowdSource.enabled) return undefined;
  if (client) return client;
  if (configurationError !== null) return undefined;

  const serviceKey = config.crowdSource.serviceKey;
  if (!serviceKey) {
    configurationError = 'CROWDSOURCE_SERVICE_KEY is not set';
    logger.error('[CrowdSource] enabled but not configured', {
      reason: configurationError,
    });
    return undefined;
  }

  try {
    client = new CrowdSource({
      serviceKey,
      ...(config.crowdSource.baseUrl === undefined
        ? {}
        : { baseUrl: config.crowdSource.baseUrl }),
    });
    logger.info('[CrowdSource] client ready', { applicationId: client.applicationId });
    return client;
  } catch (error: unknown) {
    // The SDK's configuration errors name which part of the key is wrong and never
    // echo the secret, so the message is safe to log.
    configurationError = error instanceof Error ? error.message : String(error);
    logger.error('[CrowdSource] service key rejected', { reason: configurationError });
    return undefined;
  }
}

/** Test hook. Production builds the client once and keeps it for the process. */
export function resetCrowdSourceClient(): void {
  client = null;
  configurationError = null;
}
