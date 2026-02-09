import type { HttpClient } from '../types';

export type GetSpaceTokenFn = (spaceId: string) => Promise<{ token: string; url: string }>;

export function createGetSpaceToken(httpClient: Pick<HttpClient, 'post'>): GetSpaceTokenFn {
  return async function getSpaceToken(spaceId: string): Promise<{ token: string; url: string }> {
    const res = await httpClient.post(`/spaces/${spaceId}/token`);
    const { token, url } = res.data;
    return { token: String(token), url: String(url) };
  };
}
