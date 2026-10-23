import { randomUUID } from 'node:crypto';
import { capabilityCatalogBindingSchema, type CapabilityCatalogBinding } from '@oxy.so/contracts';
import type { OxyServer } from '@oxy.so/core/server';
import type { OxyRecommendationItem } from './OxyRankingClient';

/** A present requester and independently authenticated Mention coordinator.
 * The requester bearer reaches only the configured Oxy authority. */
export interface ForegroundProfileReader {
  recommend(input: Readonly<Record<string, unknown>>): Promise<OxyRecommendationItem[]>;
}

/** The foreground round trip that failed. */
export type ForegroundRankingStage = 'approval' | 'ticket' | 'invoke' | 'cleanup';

/** Why a stage failed, reduced to values that can never carry a bearer or a body. */
export interface ForegroundRankingFailure {
  stage: ForegroundRankingStage;
  /** HTTP status Oxy answered with, when it answered. */
  status?: number;
  /** The SDK's or Oxy's error code, when it is a plain identifier. */
  code?: string;
  /** The attempt hit its own timeout rather than an answer. */
  timeout?: boolean;
}

const SAFE_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

function describeFailure(stage: ForegroundRankingStage, error: unknown): ForegroundRankingFailure {
  const failure: ForegroundRankingFailure = { stage };
  if (typeof error !== 'object' || error === null) return failure;
  const { status, code, timeout } = error as {
    status?: unknown;
    code?: unknown;
    timeout?: unknown;
  };
  if (typeof status === 'number' && Number.isInteger(status) && status > 0) failure.status = status;
  if (typeof code === 'string' && SAFE_ERROR_CODE.test(code)) failure.code = code;
  if (timeout === true) failure.timeout = true;
  return failure;
}

/**
 * A refused or failed foreground ranking. The message stays the stable
 * `FOREGROUND_*` code; `failure` says which round trip failed and how, so a
 * refusal can be told apart from Oxy being slow. SDK errors can contain request
 * bodies, so the original error is never kept.
 */
export class ForegroundRankingError extends Error {
  constructor(
    message: string,
    readonly failure: ForegroundRankingFailure,
  ) {
    super(message);
    this.name = 'ForegroundRankingError';
  }
}

export class ForegroundOxyProfileClient implements ForegroundProfileReader {
  private readonly catalog: CapabilityCatalogBinding;

  constructor(
    private readonly server: OxyServer,
    private readonly requesterToken: string,
    private readonly subjectAccountId: string,
    catalog: unknown,
    private readonly requesterAccountId: string,
  ) {
    this.catalog = capabilityCatalogBindingSchema.parse(catalog);
    if (
      !requesterToken ||
      requesterToken.length > 16_384 ||
      /\s/.test(requesterToken) ||
      !subjectAccountId ||
      !requesterAccountId
    )
      throw new Error('FOREGROUND_REQUESTER_REQUIRED');
  }

  async recommend(input: Readonly<Record<string, unknown>>): Promise<OxyRecommendationItem[]> {
    const runId = `mention_foreground_${randomUUID()}`;
    const stepId = 'recommendProfiles';
    // Cleanup is required even when issuance or invocation refuses authority.
    const authorization = await this.server.agency
      .createForegroundExecutionAuthorization(
        {
          authority: 'first_party',
          kind: 'direct_request',
          actor: { type: 'requester', accountId: this.requesterAccountId },
          resource: {
            appId: 'oxy',
            effectiveAccountId: this.subjectAccountId,
            resourceType: 'account',
            resourceId: this.subjectAccountId,
          },
          tool: 'recommendProfiles',
          expectedCatalog: this.catalog,
          runId,
          stepId,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        { requesterToken: this.requesterToken },
      )
      .catch((error: unknown) => {
        throw new ForegroundRankingError(
          'FOREGROUND_APPROVAL_REFUSED',
          describeFailure('approval', error),
        );
      });
    try {
      const grant = await this.server.agency
        // The run identity is the authorization's own: Oxy refuses ANY runId or
        // stepId on a `direct_request` ticket request
        // (`direct_request_runtime_scope_override`), so sending them here made
        // every signed-in who-to-follow fail at this step from #1309 on. The
        // claims below are still checked against the run this authorization was
        // created for.
        .issueCapabilityTicket({
          executionAuthorizationId: authorization.id,
          expectedCatalog: this.catalog,
        })
        .catch((error: unknown) => {
          throw new ForegroundRankingError(
            'FOREGROUND_TICKET_REFUSED',
            describeFailure('ticket', error),
          );
        });
      const claims = grant.claims;
      if (
        !grant.decision.allowed ||
        !grant.ticket ||
        !claims ||
        claims.tool !== stepId ||
        claims.actor.type !== 'requester' ||
        claims.actor.accountId !== this.requesterAccountId ||
        claims.autonomy !== 'read_only' ||
        claims.resource.appId !== 'oxy' ||
        claims.resource.resourceType !== 'account' ||
        claims.resource.effectiveAccountId !== this.subjectAccountId ||
        claims.resource.resourceId !== this.subjectAccountId ||
        claims.runId !== runId ||
        claims.stepId !== stepId ||
        claims.catalog?.registrationId !== this.catalog.registrationId ||
        claims.catalog.version !== this.catalog.version ||
        claims.catalog.digest !== this.catalog.digest
      ) {
        throw new ForegroundRankingError('FOREGROUND_TICKET_REFUSED', {
          stage: 'ticket',
          code: grant.decision.allowed ? 'claims_mismatch' : 'decision_refused',
        });
      }
      // Oxy derives private ranking clientId from the verified coordinator.
      // The configured application ID is retained as an explicit parity check.
      // The capability route answers `{ recommendations }` (no `{ data }`
      // envelope), unlike the service route's bare list.
      const { recommendations } = await this.server.http.request<{
        recommendations: OxyRecommendationItem[];
      }>({
        method: 'POST',
        url: '/_oxy/capabilities/profiles/recommendations',
        data: input,
        headers: { Authorization: `Capability ${grant.ticket}` },
        skipAuth: true,
        cache: false,
        deduplicate: false,
        retry: false,
        timeout: 5000,
      });
      return recommendations;
    } catch (error) {
      if (error instanceof ForegroundRankingError) throw error;
      // SDK errors can contain request bodies. Never log or return a bearer.
      throw new ForegroundRankingError(
        'FOREGROUND_PROFILE_READ_REFUSED',
        describeFailure('invoke', error),
      );
    } finally {
      try {
        await this.server.agency.revokeExecutionAuthorization(authorization.id, {
          requesterToken: this.requesterToken,
        });
      } catch (error) {
        // Do not return private data while bounded approval cleanup failed.
        throw new ForegroundRankingError(
          'FOREGROUND_APPROVAL_CLEANUP_FAILED',
          describeFailure('cleanup', error),
        );
      }
    }
  }
}
