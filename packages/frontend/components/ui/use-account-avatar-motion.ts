import type { AvatarProps } from '@oxy.so/bloom/avatar';
import { parseAvatarCharacter, useAvatarRendererCapabilities } from '@oxy.so/bloom/agent-avatar';

/** Use Bloom's public JSON boundary; a malformed stored value keeps the photo fallback. */
export function hasAccountAvatarCharacter(
  account: Pick<NonNullable<AvatarProps['account']>, 'kind' | 'character'> | null | undefined,
): boolean {
  if (account?.kind !== 'bot') return false;
  try {
    parseAvatarCharacter(account.character);
    return true;
  } catch {
    return false;
  }
}

/** Animate dense account lists only where Bloom can share live rendering. */
export function useAccountAvatarMotion(enabled = true): AvatarProps['motion'] {
  const { sharedLiveRendering } = useAvatarRendererCapabilities({ enabled });
  return sharedLiveRendering ? 'always' : 'auto';
}
