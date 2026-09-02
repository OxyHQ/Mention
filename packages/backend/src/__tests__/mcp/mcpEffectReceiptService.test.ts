import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { mcpEffectReceipts } from '../../db/schema/mcp';
import {
  finalizeMcpEffect,
  reserveMcpEffect,
  type McpEffectIdentity,
} from '../../mcp/services/mcpEffectReceiptService';

let db: Database;
const accounts = new Set<string>();

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  for (const account of accounts) {
    await db.delete(mcpEffectReceipts).where(eq(mcpEffectReceipts.oxyUserId, account));
  }
  accounts.clear();
});

afterAll(async () => {
  await closePostgres();
});

function identity(): McpEffectIdentity {
  const suffix = randomUUID();
  const oxyUserId = `account-${suffix}`;
  accounts.add(oxyUserId);
  return {
    oxyUserId,
    clientId: `client-${suffix}`,
    toolName: 'create-post',
    idempotencyKey: `mcp:${suffix.replaceAll('-', '').padEnd(64, '0')}`,
    requestFingerprint: JSON.stringify({ method: 'POST', path: '/posts', body: { text: 'hello' } }),
  };
}

describe('MCP effect receipt store', () => {
  it('gives exactly one concurrent request ownership of an effect', async () => {
    const input = identity();
    const results = await Promise.all([
      reserveMcpEffect(input),
      reserveMcpEffect(input),
    ]);

    expect(results.filter((result) => result.kind === 'reserved')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'duplicate')).toHaveLength(1);
  });

  it('keeps the completed receipt durable and detects key reuse with another body', async () => {
    const input = identity();
    const reservation = await reserveMcpEffect(input);
    expect(reservation.kind).toBe('reserved');
    if (reservation.kind !== 'reserved') return;

    await finalizeMcpEffect(reservation.receiptId, 201);
    await expect(reserveMcpEffect(input)).resolves.toMatchObject({
      kind: 'duplicate',
      status: 'succeeded',
      responseStatus: 201,
    });
    await expect(reserveMcpEffect({
      ...input,
      requestFingerprint: JSON.stringify({ method: 'POST', path: '/posts', body: { text: 'different' } }),
    })).resolves.toEqual({ kind: 'conflict' });
  });
});
