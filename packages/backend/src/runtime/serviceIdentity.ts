import { canAttestWorkloadIdentity } from '@oxy.so/core/server';

import { getOxyServiceCredentials } from '../config';

/**
 * Whether this process can act as Mention against Oxy.
 *
 * There are two ways, and a deployment has one of them without anybody
 * configuring it: in ECS the task role attests — a signed `GetCallerIdentity`
 * that Oxy replays to AWS, with no secret anywhere (oxy ADR 0026) — and
 * elsewhere an `OXY_SERVICE_API_KEY`/`OXY_SERVICE_API_SECRET` pair does. A local
 * checkout has neither, which is the honest answer to "is this feature on here".
 *
 * ## Why this is one function and not three checks
 *
 * Three call sites used to ask "do I have the key pair" and mean "do I have an
 * identity", which stopped being the same question the day the task role could
 * prove it. Left as three, removing the pair would have switched community notes
 * off, switched inference off and left a script refusing to start — each in a
 * different place, each reading like its own bug.
 *
 * `getServiceToken()` in `@oxy.so/core` makes the same choice in the same order
 * for the same reason; this only answers it up front, for the callers that want
 * to decide whether to offer something at all rather than discover it on the
 * first request.
 */
export function canAuthenticateAsService(): boolean {
  if (canAttestWorkloadIdentity()) return true;
  const { apiKey, apiSecret } = getOxyServiceCredentials();
  return Boolean(apiKey && apiSecret);
}
