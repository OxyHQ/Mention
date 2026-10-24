import { createLogger } from '@oxy.so/core/logger';
import { authenticatedClient } from '@/utils/api';
import { useAuthStore } from '@oxy.so/services/ui/client';
import { notifyFeedRankingChanged } from '@/stores/feedRankingInvalidation';

const logger = createLogger('MuteService');

class MuteService {
  muteUser(mutedId: string, viewerId: string | undefined): Promise<boolean> {
    return this.setMuted(mutedId, viewerId, true);
  }

  unmuteUser(mutedId: string, viewerId: string | undefined): Promise<boolean> {
    return this.setMuted(mutedId, viewerId, false);
  }

  private async setMuted(
    mutedId: string,
    viewerId: string | undefined,
    isMuted: boolean,
  ): Promise<boolean> {
    const controller = new AbortController();
    const cancelIfViewerChanged = () => {
      if (!viewerId || useAuthStore.getState().user?.id !== viewerId) controller.abort();
    };
    const stopWatching = useAuthStore.subscribe(cancelIfViewerChanged);
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

  async getMutedUsers(): Promise<unknown[]> {
    try {
      const res = await authenticatedClient.get<{ data?: unknown[]; mutedUsers?: unknown[] }>(
        '/mute',
      );
      return res.data.data || res.data.mutedUsers || [];
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
