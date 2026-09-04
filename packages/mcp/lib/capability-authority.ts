import {
  auditResultSchema,
  capabilityTicketClaimsSchema,
  policyDecisionSchema,
  type CapabilityTicketClaims,
} from "@oxyhq/contracts";
import { OxyServices } from "@oxyhq/core";
import { z } from "zod/v4";
import type { McpHttpConfig } from "./config.js";

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
  config: Pick<
    McpHttpConfig,
    "oxyApiUrl" | "oxyServiceApiKey" | "oxyServiceApiSecret"
  >,
): MentionCapabilityAuthority {
  const oxy = new OxyServices({ baseURL: config.oxyApiUrl });
  oxy.configureServiceAuth(config.oxyServiceApiKey, config.oxyServiceApiSecret);

  const request = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const serviceToken = await oxy.getServiceToken();
      const response = await fetch(`${config.oxyApiUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401 && attempt === 0) {
        oxy.invalidateServiceToken();
        continue;
      }
      if (!response.ok) {
        throw new Error(`Oxy capability authority returned ${response.status}`);
      }
      return response.json();
    }
    throw new Error("Oxy capability authority rejected refreshed service credentials");
  };

  return {
    async introspect(ticket) {
      const envelope = introspectionEnvelopeSchema.parse(
        await request("/capabilities/tickets/introspect", { ticket }),
      );
      if (!envelope.active || envelope.claims === undefined || envelope.decision === undefined) {
        return null;
      }
      const decision = policyDecisionSchema.parse(envelope.decision);
      if (!decision.allowed) return null;
      return capabilityTicketClaimsSchema.parse(envelope.claims);
    },

    async audit(input) {
      await request("/capabilities/audit", {
        ticket: input.ticket,
        result: input.result,
        rollback: { supported: input.rollbackSupported, attempted: false },
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });
    },
  };
}
