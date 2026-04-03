import { authenticatedClient } from '../utils/api';

export interface PokeUser {
  id: string;
  username: string;
  name: string;
  avatar?: string;
  bio?: string;
}

export interface ReceivedPoke {
  id: string;
  user: PokeUser;
  pokeCount: number;
  pokedBack: boolean;
  createdAt: string;
}

export interface SentPoke {
  id: string;
  user: PokeUser;
  createdAt: string;
}

export interface SuggestedPoke {
  user: PokeUser;
}

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

  async getReceivedPokes(): Promise<{ pokes: ReceivedPoke[] }> {
    const resp = await authenticatedClient.get('/pokes/received');
    return resp.data;
  }

  async getSentPokes(): Promise<{ pokes: SentPoke[] }> {
    const resp = await authenticatedClient.get('/pokes/sent');
    return resp.data;
  }

  async getSuggested(): Promise<{ suggestions: SuggestedPoke[] }> {
    const resp = await authenticatedClient.get('/pokes/suggested');
    return resp.data;
  }
}

export const pokeService = new PokeService();
