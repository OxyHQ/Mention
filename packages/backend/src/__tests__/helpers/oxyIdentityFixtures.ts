/** An explicit Oxy response fixture; Mention never derives these assertions. */
export function oxyIdentityFixture(input: {
  actorUri: string;
  transportAcct: string;
  canonicalAcct: string;
  network: string;
  protocol?: 'activitypub' | 'atproto';
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
