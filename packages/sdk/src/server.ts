import {
  mentionImportBatchSchema,
  mentionImportBatchResponseSchema,
  mentionImportIdSchema,
  mentionImportLookupSchema,
  mentionImportLookupResponseSchema,
  mentionImportUndoResponseSchema,
  type MentionImportBatch,
  type MentionImportLookup,
} from '@oxy.so/mention-contracts';

export const MENTION_SERVICE_APPLICATION_ID = '6a2f851751b784a86fd0e916';
export interface MentionServiceTransport {
  fetch: typeof fetch;
  dispose(): void;
}
export type MentionRequester = { accountId: string } & (
  | { token: string; taskId?: never }
  | { taskId: string; token?: never }
);
/** Structural boundary: the application owns OxyServer and its workload provider. */
export interface MentionServiceIdentity {
  createServiceClient(options: {
    baseURL: string;
    audience: `oxy-service:${string}`;
    requester: MentionRequester;
  }): MentionServiceTransport;
}
export class MentionServiceError extends Error {
  constructor(
    readonly status: number,
    readonly unknownOutcome: boolean,
  ) {
    super(
      unknownOutcome
        ? 'Mention operation outcome is unknown; retain the original batch'
        : 'Mention refused the operation',
    );
  }
}

/** Own import operations; authority and the original account proof belong to core. */
export class MentionServiceClient {
  constructor(
    private readonly transport: MentionServiceTransport,
    private readonly baseURL: string,
  ) {}
  dispose(): void {
    this.transport.dispose();
  }
  private async request(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport.fetch(new URL(path, this.baseURL), {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new MentionServiceError(0, init?.method === 'POST' || init?.method === 'DELETE');
    }
    if (!response.ok)
      throw new MentionServiceError(
        response.status,
        (init?.method === 'POST' || init?.method === 'DELETE') && response.status >= 500,
      );
    return response.json();
  }
  async importBatch(input: MentionImportBatch) {
    return mentionImportBatchResponseSchema.parse(
      await this.request('/imports/v1/posts:batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mentionImportBatchSchema.parse(input)),
      }),
    );
  }
  async lookupImports(input: MentionImportLookup) {
    const parsed = mentionImportLookupSchema.parse(input);
    const query = new URLSearchParams({ platform: parsed.platform });
    for (const id of parsed.sourceIds) query.append('sourceIds', id);
    for (const id of parsed.federatedIds) query.append('federatedIds', id);
    return mentionImportLookupResponseSchema.parse(
      await this.request(`/imports/v1/lookup?${query}`),
    );
  }
  async undoImportBatch(batchId: string) {
    return mentionImportUndoResponseSchema.parse(
      await this.request(
        `/imports/v1/batches/${encodeURIComponent(mentionImportIdSchema.parse(batchId))}`,
        { method: 'DELETE' },
      ),
    );
  }
}
export function mentionForOxyService(
  oxy: MentionServiceIdentity,
  options: {
    requester: MentionRequester;
    baseURL?: string;
    receiverApplicationId?: string;
  },
): MentionServiceClient {
  const baseURL = options.baseURL ?? 'https://api.mention.earth';
  const receiver = options.receiverApplicationId ?? MENTION_SERVICE_APPLICATION_ID;
  if (!receiver || receiver.trim() !== receiver || /\s/.test(receiver))
    throw new Error('Invalid Mention receiver application');
  return new MentionServiceClient(
    oxy.createServiceClient({
      baseURL,
      audience: `oxy-service:${receiver}`,
      requester: options.requester,
    }),
    baseURL,
  );
}
