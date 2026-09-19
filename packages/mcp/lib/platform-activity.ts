import { canAttestWorkloadIdentity, createEcosystemTraffic } from '@oxy.so/core/server';

/**
 * Publish this process's traffic and its infrastructure heartbeat to Oxy.
 *
 * ## Why there is no `OXY_ECOSYSTEM_ACTIVITY_ENABLED`
 *
 * Every deployed Oxy service publishes activity — that is the point of it, and
 * the variable was set to `true` on every task definition that has ever run
 * this code. What the flag actually stood for was "am I a deployed process, or
 * somebody's laptop", and that is a fact about where the code runs rather than
 * something to type: ECS sets the container credentials endpoint on every task
 * and nothing else does, which is the same signal the credential-free service
 * token uses to prove what this process IS (oxy ADR 0026).
 *
 * So: on the infrastructure it publishes, in a local checkout it does not, and
 * neither needs configuring. A developer who wants the publisher anyway can
 * still have it — `createEcosystemTraffic` takes an explicit location — but
 * nothing in a task definition has to say the obvious.
 */
export function startPlatformActivity(ready: () => boolean, service = 'mention-mcp') {
  if (!canAttestWorkloadIdentity()) return undefined;
  const traffic = createEcosystemTraffic({
    service,
    ready,
  });
  traffic.installFetch();
  return traffic;
}
