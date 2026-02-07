import { authenticatedClient } from '@/utils/api';

export async function getSpaceToken(spaceId: string): Promise<{ token: string; url: string }> {
  const res = await authenticatedClient.post(`/spaces/${spaceId}/token`);
  return res.data;
}
