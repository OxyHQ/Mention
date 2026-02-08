type HttpClient = {
  post: (url: string, data?: any, config?: any) => Promise<any>;
};

export type GetSpaceTokenFn = (spaceId: string) => Promise<{ token: string; url: string }>;

export function createGetSpaceToken(httpClient: HttpClient): GetSpaceTokenFn {
  return async function getSpaceToken(spaceId: string): Promise<{ token: string; url: string }> {
    const res = await httpClient.post(`/spaces/${spaceId}/token`);
    return res.data;
  };
}
