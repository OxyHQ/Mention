import { describe, expect, it } from 'bun:test';
import { mentionForOxyService, type MentionServiceIdentity } from './server';
const batch = {
  platform: 'mastodon' as const,
  batchId: 'durable-batch',
  items: [
    {
      sourceId: 'https://source.test/items/a,b',
      sourceUrl: 'https://source.test/items/a,b',
      createdAt: '2026-01-01T00:00:00Z',
      text: 'old post',
      visibility: 'public' as const,
    },
  ],
};
function harness(responses: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let disposed = false;
  let configured: Parameters<MentionServiceIdentity['createServiceClient']>[0] | undefined;
  const identity: MentionServiceIdentity = {
    createServiceClient(options) {
      configured = options;
      return {
        fetch: (async (input, init) => {
          calls.push({ url: String(input), init });
          if (disposed) throw new Error('disposed');
          const response = responses.shift();
          if (!response) throw new Error('network failure');
          return response;
        }) as typeof fetch,
        dispose() {
          disposed = true;
        },
      };
    },
  };
  return { identity, calls, options: () => configured, disposed: () => disposed };
}
describe('own Mention service SDK', () => {
  it('uses canonical workload transport with original task/account proof and no local bearer', async () => {
    const h = harness([
      Response.json({
        results: [{ sourceId: batch.items[0].sourceId, status: 'created', postId: 'p' }],
      }),
    ]);
    const requester = { accountId: 'person', taskId: 'original-move-task' };
    const client = mentionForOxyService(h.identity, { requester });
    await client.importBatch(batch);
    expect(h.options()).toEqual({
      baseURL: 'https://api.mention.earth',
      audience: 'oxy-service:6a2f851751b784a86fd0e916',
      requester,
    });
    expect(h.calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(h.calls[0]?.init?.redirect).toBe('error');
    expect(JSON.parse(h.calls[0]?.init?.body as string).batchId).toBe('durable-batch');
    client.dispose();
    expect(h.disposed()).toBe(true);
  });
  it('encodes repeated lookup IDs and preserves commas inside source URLs', async () => {
    const h = harness([Response.json({ imported: {}, federated: {} })]);
    const client = mentionForOxyService(h.identity, {
      requester: { accountId: 'person', token: 'real-session' },
    });
    await client.lookupImports({
      platform: 'mastodon',
      sourceIds: ['a,b', 'c'],
      federatedIds: ['https://source.test/a,b'],
    });
    const url = new URL(h.calls[0].url);
    expect(url.searchParams.getAll('sourceIds')).toEqual(['a,b', 'c']);
    expect(url.searchParams.getAll('federatedIds')).toEqual(['https://source.test/a,b']);
  });
  it('bounds batches before transport and never replays an unknown mutation', async () => {
    const h = harness([]);
    const client = mentionForOxyService(h.identity, {
      requester: { accountId: 'person', taskId: 'task' },
    });
    await expect(client.importBatch({ ...batch, items: [] })).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
    await expect(client.importBatch(batch)).rejects.toMatchObject({
      unknownOutcome: true,
      status: 0,
    });
    expect(h.calls).toHaveLength(1);
  });
  it('keeps account refusal distinct from ambiguous failure and encodes undo IDs', async () => {
    const h = harness([
      Response.json({}, { status: 403 }),
      Response.json({ deleted: 1, failed: 0 }),
    ]);
    const client = mentionForOxyService(h.identity, {
      requester: { accountId: 'person', taskId: 'task' },
    });
    await expect(client.importBatch(batch)).rejects.toMatchObject({
      status: 403,
      unknownOutcome: false,
    });
    await client.undoImportBatch('batch/a?b');
    expect(new URL(h.calls[1].url).pathname).toBe('/imports/v1/batches/batch%2Fa%3Fb');
    expect(h.calls).toHaveLength(2);
  });
  it('publishes with the same durable key and preserves uncertain outcomes without retry', async () => {
    const h = harness([
      Response.json({ success: true, post: { id: 'published' } }),
      Response.json({}, { status: 409 }),
      Response.json({ bad: 'response' }),
      Response.json({}, { status: 429, headers: { 'retry-after': '120' } }),
    ]);
    const client = mentionForOxyService(h.identity, {
      requester: { accountId: 'person', taskId: 'scheduled-revision' },
    });
    const input = {
      content: { text: 'hello' },
      visibility: 'public' as const,
      status: 'published' as const,
    };
    const key = `mcp:${'a'.repeat(64)}`;
    expect(await client.publish(input, key)).toEqual({
      id: 'published',
      url: 'https://mention.earth/p/published',
    });
    await expect(client.publish(input, key)).rejects.toMatchObject({
      status: 409,
      unknownOutcome: true,
    });
    await expect(client.publish(input, key)).rejects.toMatchObject({ unknownOutcome: true });
    await expect(client.publish(input, key)).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 120000,
    });
    expect(h.calls).toHaveLength(4);
    for (const call of h.calls) {
      expect(new URL(call.url).pathname).toBe('/publishing/v1/posts');
      expect(new Headers(call.init?.headers).get('Idempotency-Key')).toBe(key);
      expect(new Headers(call.init?.headers).has('X-Oxy-MCP-Tool')).toBe(false);
    }
  });
});
