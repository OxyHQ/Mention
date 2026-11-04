import { postOxyServiceJson } from '@oxy.so/mcp';
import type { auditResultSchema } from '@oxy.so/contracts';
import type { z } from 'zod/v4';
import type { McpHttpConfig } from './config.js';
import type { OxyServer } from '@oxy.so/core/server';

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
  oxy: Pick<OxyServer, 'createServiceClient'>,
): MentionCapabilityAudit {
  const transport = oxy.createServiceClient({
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
