import { authenticatedClient } from '../utils/api';

class PokeService {
  async getStatus(userId: string): Promise<{ poked: boolean }> {
    const resp = await authenticatedClient.get(`/pokes/${userId}/status`);
    return resp.data;
  }

  async poke(userId: string): Promise<{ poked: boolean }> {
    const resp = await authenticatedClient.post(`/pokes/${userId}`);
    return resp.data;
  }

  async unpoke(userId: string): Promise<{ poked: boolean }> {
    const resp = await authenticatedClient.delete(`/pokes/${userId}`);
    return resp.data;
  }
}

export const pokeService = new PokeService();
