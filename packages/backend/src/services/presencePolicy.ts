/**
 * Whose online status a viewer may learn. The presence registry asks this for
 * every answer it gives and every change it broadcasts, so the rule lives here
 * once:
 *
 * - `privacy.showOnlineStatus` off hides the account from everyone else;
 * - a block in either direction hides each account from the other (Oxy's
 *   two-way answer, asked with the viewer's own verified bearer).
 *
 * A viewer always sees themselves. Fail closed: if either read fails, every
 * account asked about is hidden — reported offline — rather than disclosed.
 */

import { accountsHidingOnlineStatus } from '../db/userProfile/userSettingsRepository';
import type { PresencePolicyPort, PresenceViewer } from '../runtime/presenceRegistry';
import { logger } from '../utils/logger';
import { blockedEitherWay } from '../utils/privacyHelpers';

async function hiddenFrom(
  viewer: PresenceViewer | null,
  userIds: readonly string[],
): Promise<Set<string>> {
  const others = [...new Set(userIds)].filter((userId) => userId !== viewer?.id);
  if (others.length === 0) return new Set();
  try {
    const [hidingStatus, blocked] = await Promise.all([
      accountsHidingOnlineStatus(others),
      viewer
        ? blockedEitherWay({ accessToken: viewer.accessToken }, others)
        : Promise.resolve(new Set<string>()),
    ]);
    return new Set([...hidingStatus, ...blocked]);
  } catch (error) {
    logger.warn('[Presence] Hiding presence: visibility could not be resolved', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Set(others);
  }
}

export const presencePolicy: PresencePolicyPort = { hiddenFrom };
