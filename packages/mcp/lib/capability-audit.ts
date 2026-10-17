import type { auditResultSchema } from '@oxy.so/contracts';
import type { z } from 'zod/v4';
import type { McpHttpConfig } from './config.js';
import { oxyServiceClient } from './oxy-service-client.js';

type AuditResult = z.infer<typeof auditResultSchema>;

/** Where `/_oxy/mcp` reports each ticket's outcome to Oxy (`/capabilities/audit`). */
export interface MentionCapabilityAudit {
  audit(input: {
    ticket: string;
    result: AuditResult;
    rollbackSupported: boolean;
    idempotencyKey?: string;
  }): Promise<void>;
}

export function createMentionCapabilityAudit(
  config: Pick<McpHttpConfig, 'oxyApiUrl' | 'oxyServiceApiKey' | 'oxyServiceApiSecret'>,
): MentionCapabilityAudit {
  const oxy = oxyServiceClient(config);

  return {
    async audit(input) {
      const body = JSON.stringify({
        ticket: input.ticket,
        result: input.result,
        rollback: { supported: input.rollbackSupported, attempted: false },
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const serviceToken = await oxy.serviceToken();
        const response = await fetch(`${config.oxyApiUrl}/capabilities/audit`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${serviceToken}`,
            'content-type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 401 && attempt === 0) {
          oxy.invalidateServiceToken();
          continue;
        }
        if (!response.ok) {
          // Oxy's own reason (`insufficient_service_scope`, `missing_application_capability`…)
          // is what tells an operator WHICH grant is missing; the status alone
          // made a binding without `capability-audit:write` an anonymous failure.
          const reason = (await response.text().catch(() => '')).slice(0, 200);
          throw new Error(
            `Oxy capability audit returned ${response.status}${reason ? `: ${reason}` : ''}`,
          );
        }
        return;
      }
      throw new Error('Oxy capability audit rejected refreshed service credentials');
    },
  };
}
