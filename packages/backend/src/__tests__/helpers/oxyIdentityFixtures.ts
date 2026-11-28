/** An explicit Oxy response fixture; Mention never derives these assertions. */
export function oxyIdentityFixture(input: {
  actorUri: string;
  transportAcct: string;
  canonicalAcct: string;
  network: string;
  protocol?: 'activitypub' | 'atproto' | 'instagram-graph';
  userId?: string;
  displayName?: string;
  bio?: string;
  avatar?: string;
}) {
  const userId = input.userId ?? 'oxy-resolved';
  const identity = {
    actorUri: input.actorUri,
    transportAcct: input.transportAcct,
    canonicalAcct: input.canonicalAcct,
    network: input.network,
    protocol: input.protocol ?? 'activitypub',
    sourceUserId: userId,
  };
  return {
    user: {
      id: userId,
      username: input.canonicalAcct,
      name: { displayName: input.displayName },
      bio: input.bio ?? '',
      avatar: input.avatar ?? null,
      externalIdentities: [identity],
      redirectedUserIds: [],
    },
    externalIdentity: { ...identity, userId },
    externalIdentities: [identity],
    redirectedUserIds: [],
  };
}

/**
 * A double of `observeOxySource` for tests that script the remote: Oxy reads the
 * actor from `serveSource` (the source, as the test serves it) and answers with
 * `resolveIdentity`'s fixture plus the document it read — the way the real Oxy
 * answers an `actorUri` resolve. A source that refuses reports its status.
 */
export function observeOxySourceDouble(
  serveSource: (url: string) => Promise<Response> | Response,
  resolveIdentity: (input: {
    actorUri: string;
    transportAcct: string;
    protocol: string;
  }) => unknown,
) {
  return async (input: { actorUri: string; transportAcct?: string; protocol: string }) => {
    const res = await serveSource(input.actorUri);
    if (!res.ok) return { status: res.status };
    const sourceDocument = (await res.json()) as Record<string, unknown>;
    const host = new URL(String(sourceDocument.id)).hostname;
    const transportAcct =
      input.transportAcct ?? `${String(sourceDocument.preferredUsername).toLowerCase()}@${host}`;
    const resolved = (await resolveIdentity({ ...input, transportAcct })) as object | null;
    if (!resolved) return { status: 404 };
    return { status: 200, resolved: { ...resolved, sourceDocument } };
  };
}

/**
 * Oxy's `serviceRequest` as a test double: `answer` scripts what Oxy says, and an
 * `actorUri` resolve also carries the document Oxy read from `serveSource` (the
 * remote, as the test serves it). A source that refuses is Oxy's 404 naming the
 * source's status, as the real route answers.
 */
export function oxyServiceRequestDouble(
  answer: (method: string, path: string, body?: unknown) => unknown,
  serveSource: (url: string) => Promise<Response> | Response,
) {
  return async (method: string, path: string, body?: unknown) => {
    const response = await answer(method, path, body);
    const actorUri = (body as { actorUri?: unknown } | undefined)?.actorUri;
    if (path !== '/federation/identities/resolve' || typeof actorUri !== 'string' || !response)
      return response;
    const source = await serveSource(actorUri);
    if (!source.ok)
      throw Object.assign(new Error('External actor could not be verified'), {
        status: 404,
        details: { sourceStatus: source.status },
      });
    return { ...(response as object), sourceDocument: await source.json() };
  };
}
