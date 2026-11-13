import type { AvatarProps } from '@oxy.so/bloom/avatar';
import {
  type AvatarCharacter,
  avatarCharacterInColor,
  parseAvatarCharacter,
  useAvatarRendererCapabilities,
} from '@oxy.so/bloom/agent-avatar';

type CharacterAccount = Pick<NonNullable<AvatarProps['account']>, 'kind' | 'character' | 'color'>;

/**
 * The character a bot account is drawn as: its stored character (which carries no paint) in the
 * account's colour, through Bloom's public JSON boundary. A malformed stored value, or one with no
 * colour to paint it in, is `undefined` and keeps the photo fallback, as Bloom's `Avatar` does.
 */
export function accountAvatarCharacter(
  account: CharacterAccount | null | undefined,
): AvatarCharacter | undefined {
  if (account?.kind !== 'bot') return undefined;
  const stored = account.character;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
  try {
    return parseAvatarCharacter(avatarCharacterInColor(stored as AvatarCharacter, account.color));
  } catch {
    return undefined;
  }
}

export function hasAccountAvatarCharacter(account: CharacterAccount | null | undefined): boolean {
  return accountAvatarCharacter(account) !== undefined;
}

/** Animate dense account lists only where Bloom can share live rendering. */
export function useAccountAvatarMotion(enabled = true): AvatarProps['motion'] {
  const { sharedLiveRendering } = useAvatarRendererCapabilities({ enabled });
  return sharedLiveRendering ? 'always' : 'auto';
}
