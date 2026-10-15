import { MentionIdentity, MentionPublishInput, MentionPublishResponse } from '@oxy.so/mention-contracts';

export class MentionPublishingError extends Error {
  constructor(
    public readonly status: number,
    public readonly unknownOutcome: boolean,
  ) {
    super(
      unknownOutcome
        ? 'Mention delivery outcome is unknown; do not issue a new effect key'
        : 'Mention refused the request',
    );
  }
}
/** A resource-scoped Oxy MCP OAuth token, never an ordinary Oxy human session. */
export class MentionPublishingClient {
  constructor(
    private readonly options: {
      accessToken: string;
      apiOrigin?: string;
      publicOrigin?: string;
      fetch?: typeof fetch;
    },
  ) {}

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const origin = this.options.apiOrigin ?? 'https://api.mention.earth';
    const response = await (this.options.fetch ?? fetch)(new URL(path, origin), {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${this.options.accessToken}`, ...init?.headers },
    });
    if (!response.ok)
      throw new MentionPublishingError(
        response.status,
        init?.method === 'POST' && (response.status >= 500 || response.status === 409),
      );
    return response.json();
  }

  async identity() {
    return MentionIdentity.parse(await this.request('/mcp/bundles/me'));
  }

  /** The key is persisted by the caller before dispatch; Mention reserves it durably. */
  async publish(input: MentionPublishInput, effectKey: string) {
    if (!/^mcp:[a-f0-9]{64}$/.test(effectKey)) throw new Error('Invalid Mention effect key');
    const body = MentionPublishInput.parse(input);
    const result = MentionPublishResponse.parse(
      await this.request('/posts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': effectKey,
          'X-Oxy-MCP-Tool': 'create-post',
        },
        body: JSON.stringify(body),
      }),
    );
    return {
      id: result.post.id,
      url: new URL(
        `/p/${encodeURIComponent(result.post.id)}`,
        this.options.publicOrigin ?? 'https://mention.earth',
      ).href,
    };
  }
}
