import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  MENTION_TOOL_POLICIES,
  mentionCapabilityRequirementsForRequest,
} from '@mention/shared-types/mcpCapabilities';
import { logger } from '../utils/logger';
import type { RequestWithMentionCapability } from './capabilityAuth.middleware';
import {
  finalizeMcpEffect,
  reserveMcpEffect,
  type McpEffectReservation,
} from '../mcp/services/mcpEffectReceiptService';

export interface CapabilityEffectReceiptDependencies {
  reserve: typeof reserveMcpEffect;
  finalize: typeof finalizeMcpEffect;
}

const defaultDependencies: CapabilityEffectReceiptDependencies = {
  reserve: reserveMcpEffect,
  finalize: finalizeMcpEffect,
};

/**
 * Reserve native capability effects before domain execution. The existing
 * receipt table is deliberately shared with MCP because its invariant is the
 * same: one account/principal/key tuple may enter Mention's effects once.
 */
export function createMentionCapabilityEffectIdempotency(
  dependencies: CapabilityEffectReceiptDependencies = defaultDependencies,
): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    const capability = (request as RequestWithMentionCapability).capability;
    if (!capability || isSafeMethod(request.method)) return next();

    const idempotencyKey = request.header('Idempotency-Key')?.trim();
    const toolName = request.header('X-Oxy-Capability-Tool')?.trim();
    if (!idempotencyKey || !toolName) {
      response.status(428).json({ error: 'capability_idempotency_required' });
      return;
    }
    const policy = MENTION_TOOL_POLICIES[toolName];
    const ownsRoute = mentionCapabilityRequirementsForRequest(request.method, request.path)
      .some((requirement) => requirement.toolName === toolName);
    if (!policy || policy.effect === 'read' || !ownsRoute) {
      response.status(400).json({ error: 'capability_tool_route_mismatch' });
      return;
    }

    const claims = capability.claims;
    let reservation: McpEffectReservation;
    try {
      reservation = await dependencies.reserve({
        oxyUserId: claims.resource.effectiveAccountId,
        clientId: [
          'capability',
          claims.coordinator.applicationId,
          claims.coordinator.credentialId,
          claims.sub,
        ].join(':'),
        toolName,
        idempotencyKey,
        requestFingerprint: fingerprintRequest(request, toolName),
      });
    } catch (error) {
      logger.error('[CapabilityEffect] Could not reserve effect', {
        ticketId: claims.jti,
        toolName,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      response.status(503).json({ error: 'capability_idempotency_unavailable' });
      return;
    }

    if (reservation.kind === 'conflict') {
      response.status(409).json({ error: 'capability_idempotency_conflict' });
      return;
    }
    if (reservation.kind === 'duplicate') {
      response.status(409).json({
        error: 'capability_effect_already_reserved',
        previousStatus: reservation.status,
        previousResponseStatus: reservation.responseStatus,
      });
      return;
    }

    let finalized = false;
    const finish = (responseStatus: number, indeterminate: boolean): void => {
      if (finalized) return;
      finalized = true;
      void dependencies.finalize(reservation.receiptId, responseStatus, indeterminate)
        .catch((error) => {
          logger.error('[CapabilityEffect] Could not finalize effect receipt', {
            receiptId: reservation.receiptId,
            ticketId: claims.jti,
            toolName,
            reason: error instanceof Error ? error.message : 'unknown',
          });
        });
    };
    response.once('finish', () => finish(response.statusCode, false));
    response.once('close', () => {
      if (!response.writableEnded) finish(499, true);
    });
    next();
  };
}

function isSafeMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function fingerprintRequest(request: Request, toolName: string): string {
  return JSON.stringify({
    toolName,
    method: request.method.toUpperCase(),
    path: request.path,
    query: canonicalize(request.query),
    body: canonicalize(request.body),
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
