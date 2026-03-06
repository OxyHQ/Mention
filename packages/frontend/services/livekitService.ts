import { authenticatedClient } from '@/utils/api';

export async function getRoomToken(roomId: string): Promise<{ token: string; url: string }> {
  const res = await authenticatedClient.post(`/rooms/${roomId}/token`);
  return res.data;
}
