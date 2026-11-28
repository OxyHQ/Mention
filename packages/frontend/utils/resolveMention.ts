import { feedService, type ExternalActorResolution } from '@/services/feedService';

/** Resolve imported source links to a verified Oxy identity before navigating. */
export async function resolveMention(source: string): Promise<ExternalActorResolution | null> {
  const resolved = await feedService.resolveExternalActor(source);
  if (resolved?.oxyUserId) return resolved;

  // Some discovery servers accept an acct through WebFinger but cannot resolve
  // its human HTML page. Only /@handle spells an acct; /users/opaque-id does not.
  // This is a discovery candidate, never the destination or a manufactured ID.
  const url = new URL(source);
  if (url.username || url.password || url.port || url.search || url.hash) return null;
  const match = /^\/@([a-zA-Z0-9_.-]+(?:@[a-zA-Z0-9.-]+)?)\/?$/.exec(url.pathname);
  if (!match || !url.hostname.includes('.')) return null;
  const handle = match[1].includes('@') ? match[1] : `${match[1]}@${url.hostname}`;
  const byHandle = await feedService.resolveExternalActor(handle);
  return byHandle?.oxyUserId ? byHandle : null;
}
