import type { MutedUsersResponse, SerializedMute } from '@mention/shared-types';
import { createLogger } from '@oxy.so/core/logger';
import { authenticatedClient } from '@/utils/api';
import type { OxyRuntime } from '@oxy.so/services/runtime';
import { notifyFeedRankingChanged } from '@/stores/feedRankingInvalidation';

const logger = createLogger('MuteService');

/**
 * Who a write is for: the viewer it was started by, and the Oxy session runtime
 * (`useOxyRuntime()`) that says who is signed in now. The write is cancelled
 * when that stops being the viewer.
 */
export interface MuteViewer {
  viewerId: string | undefined;
  runtime: Pick<OxyRuntime, 'getSnapshot' | 'subscribe'>;
}

class MuteService {
  muteUser(mutedId: string, viewer: MuteViewer): Promise<boolean> {
    return this.setMuted(mutedId, viewer, true);
  }

  unmuteUser(mutedId: string, viewer: MuteViewer): Promise<boolean> {
    return this.setMuted(mutedId, viewer, false);
  }

  private async setMuted(
    mutedId: string,
    { viewerId, runtime }: MuteViewer,
    isMuted: boolean,
  ): Promise<boolean> {
    const controller = new AbortController();
    const cancelIfViewerChanged = () => {
      if (!viewerId || runtime.getSnapshot().account?.id !== viewerId) controller.abort();
    };
    const stopWatching = runtime.subscribe(cancelIfViewerChanged);
    try {
      cancelIfViewerChanged();
      if (controller.signal.aborted) return false;
      if (isMuted)
        await authenticatedClient.post('/mute', { mutedId }, { signal: controller.signal });
      else await authenticatedClient.delete(`/mute/${mutedId}`, { signal: controller.signal });
      notifyFeedRankingChanged(viewerId);
      return !controller.signal.aborted;
    } catch (error) {
      logger.warn('Failed to update muted user', { error });
      return false;
    } finally {
      stopWatching();
    }
  }

  async getMutedUsers(): Promise<SerializedMute[]> {
    try {
      const res = await authenticatedClient.get<MutedUsersResponse>('/mute');
      return res.data.mutes;
    } catch (error) {
      logger.warn('Failed to get muted users', { error });
      return [];
    }
  }

  async checkMuted(userId: string): Promise<boolean> {
    try {
      const res = await authenticatedClient.get<{ isMuted?: boolean }>(`/mute/check/${userId}`);
      return res.data.isMuted || false;
    } catch {
      return false;
    }
  }
}

export const muteService = new MuteService();
