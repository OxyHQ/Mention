import { authenticatedClient } from "@/utils/api";

class MuteService {
  async muteUser(mutedId: string): Promise<boolean> {
    try {
      await authenticatedClient.post("/mute", { mutedId });
      return true;
    } catch (error) {
      console.warn("Failed to mute user", error);
      return false;
    }
  }

  async unmuteUser(mutedId: string): Promise<boolean> {
    try {
      await authenticatedClient.delete(`/mute/${mutedId}`);
      return true;
    } catch (error) {
      console.warn("Failed to unmute user", error);
      return false;
    }
  }

  async getMutedUsers(): Promise<any[]> {
    try {
      const res = await authenticatedClient.get("/mute");
      return res.data.data || res.data.mutedUsers || [];
    } catch (error) {
      console.warn("Failed to get muted users", error);
      return [];
    }
  }

  async checkMuted(userId: string): Promise<boolean> {
    try {
      const res = await authenticatedClient.get(`/mute/check/${userId}`);
      return res.data.isMuted || false;
    } catch (error) {
      return false;
    }
  }
}

export const muteService = new MuteService();
