import {
  crowdSourceForOxyService,
  resetCrowdSourceForOxyService,
  type CrowdSource,
} from '@crowdsource.you/core';

import { config } from '../../config';
import { logger } from '../../utils/logger';

/**
 * Mention's CrowdSource client, which is now three lines of application policy
 * around a library call.
 *
 * Everything this file used to hold — build once, present the Oxy service token,
 * decide whether this process can authenticate at all, resolve the tenant at
 * boot so an unbound application is visible before the first report — moved into
 * `@crowdsource.you/core`. It had to: Homiio and Allo each carried their own
 * copy of the same hundred lines, Homiio's being this one with the name swapped,
 * and none of those decisions were ever Mention's to make.
 *
 * What is left below is the part that genuinely IS Mention's.
 */

/** The client, or `undefined` where this deployment cannot authenticate. */
export function getCrowdSourceClient(): CrowdSource | undefined {
  return crowdSourceForOxyService({
    ...(config.crowdSource.baseUrl === undefined
      ? {}
      : { baseUrl: config.crowdSource.baseUrl }),
    logger: {
      info: (message, context) => logger.info(message, context),
      error: (message, context) => logger.error(message, context),
    },
  });
}

/**
 * Whether reports may LEAVE this deployment.
 *
 * Stricter than having a client, on purpose, and this one IS Mention's call. A
 * report delivered with no way to receive the decision is worse than one held
 * locally: the case is judged, the outcome is signed to an endpoint nothing
 * verifies, and the gap is invisible until somebody wonders why nothing ever
 * came back. So the webhook secret — the one thing here that is genuinely
 * configuration — gates the delivery loop.
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
  resetCrowdSourceForOxyService();
}
