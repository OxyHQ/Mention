import type { Request, Response } from 'express';

/**
 * The request-side half of an effect receipt, shared by the two front doors
 * that reserve one before a write runs: MCP (`mcpEffectIdempotency`) and
 * native capabilities (`capabilityEffectIdempotency.middleware`). Both write
 * to the same receipt table under the same invariant, so they fingerprint and
 * settle a request the same way, from one place.
 */

/** Methods that cannot have an effect, so never need a receipt. */
export function isSafeMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/** The stored identity of a request: same tool, route, query and body, in key order. */
export function fingerprintEffectRequest(req: Request, toolName: string): string {
  return JSON.stringify({
    toolName,
    method: req.method.toUpperCase(),
    path: req.path,
    query: canonicalize(req.query),
    body: canonicalize(req.body),
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

/**
 * Settle a reserved receipt exactly once when the response ends: with the
 * status it finished on, or as 499 + indeterminate when the connection closed
 * before it did (the effect may or may not have happened).
 */
export function settleReceiptWhenResponseEnds(
  res: Response,
  settle: (responseStatus: number, indeterminate: boolean) => Promise<void>,
  onSettleError: (error: unknown) => void,
): void {
  let settled = false;
  const finish = (responseStatus: number, indeterminate: boolean): void => {
    if (settled) return;
    settled = true;
    void settle(responseStatus, indeterminate).catch(onSettleError);
  };
  res.once('finish', () => finish(res.statusCode, false));
  res.once('close', () => {
    if (!res.writableEnded) finish(499, true);
  });
}
