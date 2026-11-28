// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { authenticatedClient } from '../utils/api';

export interface PokeUser {
  id: string;
  username: string;
  name: {
    displayName: string;
  };
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
    const resp = await authenticatedClient.get<{ poked: boolean }>(`/pokes/${userId}/status`);
    return resp.data;
  }

  async poke(userId: string): Promise<{ poked: boolean }> {
    const resp = await authenticatedClient.post<{ poked: boolean }>(`/pokes/${userId}`);
    return resp.data;
  }

  async unpoke(userId: string): Promise<{ poked: boolean }> {
    const resp = await authenticatedClient.delete<{ poked: boolean }>(`/pokes/${userId}`);
    return resp.data;
  }

  async getReceivedPokes(): Promise<{ pokes: ReceivedPoke[] }> {
    const resp = await authenticatedClient.get<{ pokes: ReceivedPoke[] }>('/pokes/received');
    return resp.data;
  }

  async getSentPokes(): Promise<{ pokes: SentPoke[] }> {
    const resp = await authenticatedClient.get<{ pokes: SentPoke[] }>('/pokes/sent');
    return resp.data;
  }

  async getSuggested(): Promise<{ suggestions: SuggestedPoke[] }> {
    const resp = await authenticatedClient.get<{ suggestions: SuggestedPoke[] }>(
      '/pokes/suggested',
    );
    return resp.data;
  }
}

export const pokeService = new PokeService();
