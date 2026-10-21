import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../lib/create-server.js';
import { requestContext, type RequestContext } from '../lib/context.js';

const originalFetch = globalThis.fetch;
const canonicalFeed = {
  items: [
    { id: 'reply', metadata: { createdAt: '2026-10-21T10:00:00Z' }, content: { text: 'Reply' } },
  ],
  slices: [
    {
      _sliceKey: 'parent+reply',
      reason: { type: 'replyContext' },
      items: [
        { post: { id: 'parent', content: { text: 'Context' } } },
        { post: { id: 'reply', content: { text: 'Reply' } } },
      ],
    },
  ],
  hasMore: true,
  nextCursor: 'opaque-cursor',
  totalCount: 1,
};

function captureFetch(body: unknown = { success: true, data: canonicalFeed }, status = 200) {
  const calls: Array<{ url: URL; headers: Headers }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
    return Response.json(body, { status });
  }) as typeof fetch;
  return calls;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  context: RequestContext = {
    userToken: 'test-token',
    authMode: 'central',
    scopes: new Set(['social.read']),
  },
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'feed-audit-test', version: '1.0.0' });
  const server = createMcpServer();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await requestContext.run(context, () => client.callTool({ name, arguments: args }));
  } finally {
    await client.close();
    await server.close();
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('descriptor feed reads', () => {
  test('preserves the canonical response alongside readable text and defaults to explore', async () => {
    const calls = captureFetch();
    const result = await callTool('get-feed', { limit: 20, cursor: 'previous-cursor' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(canonicalFeed);
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('2026-10-21T10:00:00Z') },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe('/feed/mtn');
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      descriptor: 'explore',
      limit: '20',
      cursor: 'previous-cursor',
    });
  });

  for (const descriptor of [
    'following_direct',
    'mutuals',
    'friends_popular',
    'friends_of_friends',
    'media',
    'trending',
    'author|user-1|replies',
    'lane|lane-1',
    'trend|two words',
    'custom|feed-1',
    'feedgen|at://did:plc:abc/app.bsky.feed.generator/news',
  ]) {
    test(`passes the validated ${descriptor} descriptor without changing it`, async () => {
      const calls = captureFetch();
      const result = await callTool('get-feed', { descriptor });
      expect(result.isError).toBeFalsy();
      expect(calls[0]?.url.searchParams.get('descriptor')).toBe(descriptor);
    });
  }

  for (const descriptor of [
    'saved',
    'list|private-list',
    'following|extra',
    'author|u|invalid',
    'unknown',
  ]) {
    test(`refuses ${descriptor} before reaching the API`, async () => {
      const calls = captureFetch();
      const result = await callTool('get-feed', { descriptor });
      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
    });
  }

  test('preserves the social.read scope gate', async () => {
    const calls = captureFetch();
    const result = await callTool(
      'get-feed',
      { descriptor: 'following' },
      { userToken: 'test', authMode: 'central', scopes: new Set(['social.posts.read']) },
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  for (const descriptor of [
    'for_you',
    'following',
    'following_direct',
    'videos',
    'media',
    'mutuals',
    'friends_popular',
    'friends_of_friends',
    'custom|f',
  ]) {
    test(`requires a token for ${descriptor}`, async () => {
      const calls = captureFetch();
      const result = await callTool('get-feed', { descriptor }, { scopes: new Set() });
      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
    });
  }

  test('keeps the exact get-feed capability binding', async () => {
    const calls = captureFetch();
    const result = await callTool(
      'get-feed',
      { descriptor: 'mutuals' },
      {
        userToken: 'test-capability',
        authMode: 'capability',
        authorizationScheme: 'Capability',
        toolName: 'get-feed',
        scopes: new Set(['social.read']),
      },
    );
    expect(result.isError).toBeFalsy();
    expect(calls[0]?.headers.get('Authorization')).toBe('Capability test-capability');
    expect(calls[0]?.headers.get('X-Oxy-Capability-Tool')).toBe('get-feed');
  });

  test('reports API refusal without presenting a successful structured response', async () => {
    captureFetch({ error: 'Feed unavailable' }, 403);
    const result = await callTool('get-feed', { descriptor: 'custom|f' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});

describe('existing feeds preserve complete responses', () => {
  for (const name of [
    'get-for-you-feed',
    'get-explore-feed',
    'get-following-feed',
    'get-videos-feed',
    'get-user-feed',
    'get-posts-by-hashtag',
  ]) {
    test(`${name} preserves slices, dates, reasons and cursors`, async () => {
      captureFetch();
      const result = await callTool(name, { userId: 'u', hashtag: 'bun' });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(canonicalFeed);
    });
  }

  for (const [name, args, scope] of [
    ['get-replies', { parentId: 'parent' }, 'social.read'],
    ['get-feed-item', { id: 'parent' }, 'social.read'],
    ['get-list-timeline', { id: 'list' }, 'social.lists.read'],
    ['get-saved-posts', {}, 'social.posts.read'],
  ] as const) {
    test(`${name} preserves its API response under its existing capability`, async () => {
      captureFetch(canonicalFeed);
      const result = await callTool(name, args, {
        userToken: 'test',
        authMode: 'central',
        scopes: new Set([scope]),
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(canonicalFeed);
    });
  }

  test('preserves an empty page with a continuation cursor', async () => {
    const emptyPage = { items: [], slices: [], hasMore: true, nextCursor: 'next' };
    captureFetch({ success: true, data: emptyPage });
    const result = await callTool('get-feed', {});
    expect(result.structuredContent).toEqual(emptyPage);
  });
});
