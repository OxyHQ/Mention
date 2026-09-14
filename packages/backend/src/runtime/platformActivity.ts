import { createEcosystemTraffic } from '@oxy.so/core/server';

/** Start once per deployed process; local sessions have no infrastructure location. */
export function startPlatformActivity(ready: () => boolean, service = 'mention') {
  if (process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED !== 'true') return undefined;
  const traffic = createEcosystemTraffic({
    service,
    ready,
  });
  traffic.installFetch();
  return traffic;
}
