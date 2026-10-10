import {
  auditResultSchema,
  capabilityTicketClaimsSchema,
  policyDecisionSchema,
  type CapabilityTicketClaims,
} from '@oxy.so/contracts';
import { oxyServiceClient } from './oxy-service-client.js';
import { z } from 'zod/v4';
import type { McpHttpConfig } from './config.js';

const introspectionEnvelopeSchema = z.object({
  active: z.boolean(),
  claims: z.unknown().optional(),
  decision: z.unknown().optional(),
  error: z.string().optional(),
});

type AuditResult = z.infer<typeof auditResultSchema>;

export interface MentionCapabilityAuthority {
  introspect(ticket: string): Promise<CapabilityTicketClaims | null>;
  audit(input: {
    ticket: string;
    result: AuditResult;
    rollbackSupported: boolean;
    idempotencyKey?: string;
  }): Promise<void>;
}

export function createMentionCapabilityAuthority(
  config: Pick<McpHttpConfig, 'oxyApiUrl' | 'oxyServiceApiKey' | 'oxyServiceApiSecret'>,
): MentionCapabilityAuthority {
  const oxy = oxyServiceClient(config);

  const request = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const serviceToken = await oxy.serviceToken();
      const response = await fetch(`${config.oxyApiUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${serviceToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401 && attempt === 0) {
        oxy.invalidateServiceToken();
        continue;
      }
      if (!response.ok) {
        // Oxy's own reason (`insufficient_service_scope`, `missing_application_capability`…)
        // is what tells an operator WHICH grant is missing; the status alone
        // made a binding without `capabilities:read` an anonymous 503.
        const reason = (await response.text().catch(() => '')).slice(0, 200);
        throw new Error(
          `Oxy capability authority returned ${response.status}${reason ? `: ${reason}` : ''}`,
        );
      }
      return response.json();
    }
    throw new Error('Oxy capability authority rejected refreshed service credentials');
  };

  return {
    async introspect(ticket) {
      const envelope = introspectionEnvelopeSchema.parse(
        await request('/capabilities/tickets/introspect', { ticket }),
      );
      if (!envelope.active || envelope.claims === undefined || envelope.decision === undefined) {
        return null;
      }
      const decision = policyDecisionSchema.parse(envelope.decision);
      if (!decision.allowed) return null;
      return capabilityTicketClaimsSchema.parse(envelope.claims);
    },

    async audit(input) {
      await request('/capabilities/audit', {
        ticket: input.ticket,
        result: input.result,
        rollback: { supported: input.rollbackSupported, attempted: false },
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });
    },
  };
}
