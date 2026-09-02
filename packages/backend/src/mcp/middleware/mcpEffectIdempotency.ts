import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  MENTION_TOOL_POLICIES,
  mentionCapabilityRequirementsForRequest,
} from '@mention/shared-types/mcpCapabilities';
import { logger } from '../../utils/logger';
import type { OxyAuthRequestWithMcp } from './mcpAuth';
import {
  finalizeMcpEffect,
  reserveMcpEffect,
  type McpEffectReservation,
} from '../services/mcpEffectReceiptService';

const EFFECT_KEY_PATTERN = /^mcp:[a-f0-9]{64}$/;

export interface EffectReceiptDependencies {
  reserve: typeof reserveMcpEffect;
  finalize: typeof finalizeMcpEffect;
}

const defaultDependencies: EffectReceiptDependencies = {
  reserve: reserveMcpEffect,
  finalize: finalizeMcpEffect,
};

/**
 * Reserve each MCP write before entering Mention's domain routes.
 *
 * Ordinary Oxy sessions never pass through this branch. External MCP calls
 * must carry the key and exact tool name injected by Mention's MCP transport;
 * a duplicate is refused before controllers, federation, or outboxes run.
 */
export function createMcpEffectIdempotency(
  dependencies: EffectReceiptDependencies = defaultDependencies,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const mcp = (req as OxyAuthRequestWithMcp).mcp;
    if (!mcp || isSafeMethod(req.method)) return next();

    const idempotencyKey = req.header('Idempotency-Key')?.trim();
    const toolName = req.header('X-Oxy-MCP-Tool')?.trim();
    if (!idempotencyKey || !EFFECT_KEY_PATTERN.test(idempotencyKey) || !toolName) {
      res.status(428).json({
        error: 'mcp_idempotency_required',
        message: 'Effectful MCP requests require a transport-bound idempotency key and tool name.',
      });
      return;
    }

    const requirements = mentionCapabilityRequirementsForRequest(req.method, req.path);
    const policy = MENTION_TOOL_POLICIES[toolName];
    if (
      !policy ||
      policy.effect === 'read' ||
      !requirements.some((requirement) => requirement.toolName === toolName)
    ) {
      res.status(400).json({
        error: 'mcp_tool_route_mismatch',
        message: 'The declared MCP tool does not own this effect route.',
      });
      return;
    }

    let reservation: McpEffectReservation;
    try {
      reservation = await dependencies.reserve({
        oxyUserId: mcp.activeUserId,
        clientId: mcp.clientId,
        toolName,
        idempotencyKey,
        requestFingerprint: fingerprintRequest(req, toolName),
      });
    } catch (error) {
      logger.error('[McpEffect] Could not reserve effect', {
        toolName,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      res.status(503).json({
        error: 'mcp_idempotency_unavailable',
        message: 'Mention could not safely reserve this effect. Nothing was executed.',
      });
      return;
    }

    if (reservation.kind === 'conflict') {
      res.status(409).json({
        error: 'mcp_idempotency_conflict',
        message: 'This idempotency key was already used for a different request.',
      });
      return;
    }
    if (reservation.kind === 'duplicate') {
      res.status(409).json({
        error: 'mcp_effect_already_reserved',
        message: 'This MCP effect was already reserved and was not executed again.',
        previousStatus: reservation.status,
        previousResponseStatus: reservation.responseStatus,
      });
      return;
    }

    let finalized = false;
    const finish = (responseStatus: number, indeterminate: boolean): void => {
      if (finalized) return;
      finalized = true;
      void dependencies.finalize(
        reservation.receiptId,
        responseStatus,
        indeterminate,
      ).catch((error) => {
        logger.error('[McpEffect] Could not finalize effect receipt', {
          receiptId: reservation.receiptId,
          toolName,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      });
    };

    res.once('finish', () => finish(res.statusCode, false));
    res.once('close', () => {
      if (!res.writableEnded) finish(499, true);
    });
    next();
  };
}

function isSafeMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function fingerprintRequest(req: Request, toolName: string): string {
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
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}
