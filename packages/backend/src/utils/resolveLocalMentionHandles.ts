import { getServiceOxyClient } from './oxyHelpers';

export function stripMentionHandle(handle: string): string {
  return handle.replace(/^@+/, '').trim();
}

async function resolveOneHandle(
  username: string,
): Promise<{ handle: string; oxyUserId: string }> {
  if (username.includes('@')) {
    throw new Error('Federated handles cannot be collaborators');
  }

  const oxy = getServiceOxyClient();
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

  return { handle: username, oxyUserId: profile.id };
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

  return Promise.all(handles.map((username) => resolveOneHandle(username)));
}
