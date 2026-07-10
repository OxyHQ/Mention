import { getServiceOxyClient } from './oxyHelpers';

export function stripMentionHandle(handle: string): string {
  return handle.replace(/^@+/, '').trim();
}

export async function resolveLocalMentionHandles(
  rawHandles: string[],
): Promise<Array<{ handle: string; oxyUserId: string }>> {
  const handles = rawHandles
    .filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
    .map((h) => stripMentionHandle(h))
    .filter((h) => h.length > 0);

  if (handles.length === 0) {
    return [];
  }

  const oxy = getServiceOxyClient();
  const users: Array<{ handle: string; oxyUserId: string }> = [];

  for (const username of handles) {
    if (username.includes('@')) {
      throw new Error('Federated handles cannot be collaborators');
    }

    let profile;
    try {
      profile = await oxy.getProfileByUsername(username, { cache: false });
    } catch {
      throw new Error(`Unknown user: @${username}`);
    }

    if (!profile?.id) {
      throw new Error(`Unknown user: @${username}`);
    }

    if (profile.type === 'federated') {
      throw new Error(`Federated users cannot be collaborators: @${username}`);
    }

    users.push({ handle: username, oxyUserId: profile.id });
  }

  return users;
}
