import { postOxyServiceJson } from '@oxy.so/mcp';
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
  config: Pick<McpHttpConfig, 'oxyApiUrl'>,
): MentionCapabilityAudit {
  const transport = oxyServiceClient(config).createServiceClient({
    baseURL: config.oxyApiUrl,
    audience: 'oxy-api',
  });
  return {
    async audit(input) {
      await postOxyServiceJson(
        {
          ticket: input.ticket,
          result: input.result,
          rollback: { supported: input.rollbackSupported, attempted: false },
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        },
        { endpoint: `${config.oxyApiUrl}/capabilities/audit`, transport, timeoutMs: 10_000 },
      );
    },
  };
}
