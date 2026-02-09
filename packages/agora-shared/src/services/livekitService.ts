import type { HttpClient } from '../types';

export type GetRoomTokenFn = (roomId: string) => Promise<{ token: string; url: string }>;

export function createGetRoomToken(httpClient: Pick<HttpClient, 'post'>): GetRoomTokenFn {
  return async function getRoomToken(roomId: string): Promise<{ token: string; url: string }> {
    const res = await httpClient.post(`/rooms/${roomId}/token`);
    const { token, url } = res.data;
    return { token: String(token), url: String(url) };
  };
}
