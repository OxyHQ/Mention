import {
  crowdSourceForOxyService,
  resetCrowdSourceForOxyService,
  type CrowdSource,
} from '@crowdsource.you/core';

import { config } from '../../config';
import { getRuntimeOxyClient } from '../../runtime/oxyClient';
import { logger } from '../../utils/logger';

let cachedClient:
  | {
      oxy: ReturnType<typeof getRuntimeOxyClient>;
      baseUrl: string | undefined;
      client: CrowdSource;
    }
  | undefined;

/** Shared infrastructure identity; construction is not proof of live authority.
 * Credential resolution, attestation and refusal occur at the shared transport.
 */
export function getCrowdSourceClient(): CrowdSource | undefined {
  const oxy = getRuntimeOxyClient();
  const baseUrl = config.crowdSource.baseUrl;
  if (cachedClient?.oxy === oxy && cachedClient.baseUrl === baseUrl) return cachedClient.client;
  cachedClient?.client.dispose();
  cachedClient = undefined;
  const client = crowdSourceForOxyService({
    oxy,
    ...(config.crowdSource.baseUrl === undefined ? {} : { baseUrl: config.crowdSource.baseUrl }),
    logger: {
      info: (message, context) => logger.info(message, context),
      error: (message, context) => logger.error(message, context),
    },
  });
  // This client has service identity only. Requester-bound clients remain per operation.
  if (client) cachedClient = { oxy, baseUrl, client };
  return client;
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
  cachedClient?.client.dispose();
  cachedClient = undefined;
  resetCrowdSourceForOxyService();
}
