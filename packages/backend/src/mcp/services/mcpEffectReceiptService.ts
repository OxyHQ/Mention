import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import {
  mcpEffectReceipts,
  type McpEffectReceiptRow,
} from '../../db/schema/mcp';

export interface McpEffectIdentity {
  oxyUserId: string;
  clientId: string;
  toolName: string;
  idempotencyKey: string;
  requestFingerprint: string;
}

export type McpEffectReservation =
  | { kind: 'reserved'; receiptId: string }
  | {
    kind: 'duplicate';
    status: McpEffectReceiptRow['status'];
    responseStatus: number | null;
  }
  | { kind: 'conflict' };

export async function reserveMcpEffect(
  identity: McpEffectIdentity,
): Promise<McpEffectReservation> {
  const idempotencyKeyHash = sha256(identity.idempotencyKey);
  const requestHash = sha256(identity.requestFingerprint);
  const inserted = await getDb()
    .insert(mcpEffectReceipts)
    .values({
      oxyUserId: identity.oxyUserId,
      clientId: identity.clientId,
      toolName: identity.toolName,
      idempotencyKeyHash,
      requestHash,
    })
    .onConflictDoNothing({
      target: [
        mcpEffectReceipts.oxyUserId,
        mcpEffectReceipts.clientId,
        mcpEffectReceipts.idempotencyKeyHash,
      ],
    })
    .returning({ id: mcpEffectReceipts.id });

  if (inserted[0]) {
    return { kind: 'reserved', receiptId: inserted[0].id };
  }

  const [existing] = await getDb()
    .select({
      requestHash: mcpEffectReceipts.requestHash,
      status: mcpEffectReceipts.status,
      responseStatus: mcpEffectReceipts.responseStatus,
    })
    .from(mcpEffectReceipts)
    .where(and(
      eq(mcpEffectReceipts.oxyUserId, identity.oxyUserId),
      eq(mcpEffectReceipts.clientId, identity.clientId),
      eq(mcpEffectReceipts.idempotencyKeyHash, idempotencyKeyHash),
    ))
    .limit(1);

  if (!existing) {
    throw new Error('MCP effect reservation conflicted but could not be read back');
  }
  if (existing.requestHash !== requestHash) return { kind: 'conflict' };
  return {
    kind: 'duplicate',
    status: existing.status,
    responseStatus: existing.responseStatus,
  };
}

export async function finalizeMcpEffect(
  receiptId: string,
  responseStatus: number,
  indeterminate = false,
): Promise<void> {
  await getDb()
    .update(mcpEffectReceipts)
    .set({
      status: indeterminate
        ? 'indeterminate'
        : responseStatus < 400
          ? 'succeeded'
          : 'failed',
      responseStatus,
      completedAt: new Date(),
    })
    .where(and(
      eq(mcpEffectReceipts.id, receiptId),
      eq(mcpEffectReceipts.status, 'started'),
    ));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
