import { randomUUID } from 'node:crypto';
import { capabilityCatalogBindingSchema, type CapabilityCatalogBinding } from '@oxy.so/contracts';
import type { OxyServer } from '@oxy.so/core/server';

/** A present requester and independently authenticated Mention coordinator.
 * The requester bearer reaches only the configured Oxy authority. */
export interface ForegroundProfileReader {
  recommend(input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export class ForegroundOxyProfileClient implements ForegroundProfileReader {
  private readonly catalog: CapabilityCatalogBinding;

  constructor(
    private readonly server: OxyServer,
    private readonly requesterToken: string,
    private readonly subjectAccountId: string,
    catalog: unknown,
  ) {
    this.catalog = capabilityCatalogBindingSchema.parse(catalog);
    if (
      !requesterToken ||
      requesterToken.length > 16_384 ||
      /\s/.test(requesterToken) ||
      !subjectAccountId
    )
      throw new Error('FOREGROUND_REQUESTER_REQUIRED');
  }

  async recommend(input: Readonly<Record<string, unknown>>): Promise<unknown> {
    const runId = `mention_foreground_${randomUUID()}`;
    const stepId = 'recommendProfiles';
    // Cleanup is required even when issuance or invocation refuses authority.
    const authorization = await this.server.agency
      .createForegroundExecutionAuthorization(
        {
          tool: 'recommendProfiles',
          expectedCatalog: this.catalog,
          runId,
          stepId,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        { requesterToken: this.requesterToken },
      )
      .catch(() => {
        throw new Error('FOREGROUND_APPROVAL_REFUSED');
      });
    try {
      const grant = await this.server.agency.issueCapabilityTicket({
        executionAuthorizationId: authorization.id,
        expectedCatalog: this.catalog,
        runId,
        stepId,
      });
      const claims = grant.claims;
      if (
        !grant.decision.allowed ||
        !grant.ticket ||
        !claims ||
        claims.tool !== stepId ||
        claims.actor.type !== 'requester' ||
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
        throw new Error('FOREGROUND_TICKET_REFUSED');
      }
      // Oxy derives private ranking clientId from the verified coordinator.
      // The configured application ID is retained as an explicit parity check.
      return await this.server.http.request<unknown>({
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
    } catch {
      // SDK errors can contain request bodies. Never log or return a bearer.
      throw new Error('FOREGROUND_PROFILE_READ_REFUSED');
    } finally {
      try {
        await this.server.agency.revokeExecutionAuthorization(authorization.id, {
          requesterToken: this.requesterToken,
        });
      } catch {
        // Do not return private data while bounded approval cleanup failed.
        throw new Error('FOREGROUND_APPROVAL_CLEANUP_FAILED');
      }
    }
  }
}
