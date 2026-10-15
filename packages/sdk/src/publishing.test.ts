import { describe, expect, it } from 'bun:test';
import { MentionPublishingClient, MentionPublishingError } from './index';
const key = `mcp:${'a'.repeat(64)}`;
describe('Mention publishing SDK', () => {
  it('sends the scoped token and stable effect key; validates the response', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const client = new MentionPublishingClient({
      accessToken: 'resource-scoped-token',
      fetch: (async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({ success: true, post: { id: 'post-1' } });
      }) as typeof fetch,
    });
    expect(
      await client.publish(
        { content: { text: 'hello' }, visibility: 'public', status: 'published' },
        key,
      ),
    ).toEqual({ id: 'post-1', url: 'https://mention.earth/p/post-1' });
    expect(requests[0]?.init?.headers).toEqual({
      Authorization: 'Bearer resource-scoped-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      'X-Oxy-MCP-Tool': 'create-post',
    });
    expect(requests[0]?.init?.redirect).toBe('error');
  });
  it('does not replay or synthesize success for a reserved effect', async () => {
    let calls = 0;
    const client = new MentionPublishingClient({
      accessToken: 'scoped',
      fetch: (async () => {
        calls++;
        return Response.json({ error: 'mcp_effect_already_reserved' }, { status: 409 });
      }) as typeof fetch,
    });
    await expect(
      client.publish(
        { content: { text: 'hello' }, visibility: 'public', status: 'published' },
        key,
      ),
    ).rejects.toBeInstanceOf(MentionPublishingError);
    expect(calls).toBe(1);
  });
  it('refuses invalid effect keys before contacting Mention', async () => {
    let calls = 0;
    const client = new MentionPublishingClient({
      accessToken: 'scoped',
      fetch: (async () => {
        calls++;
        return Response.json({});
      }) as typeof fetch,
    });
    await expect(
      client.publish(
        { content: { text: 'hello' }, visibility: 'public', status: 'published' },
        'new',
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
