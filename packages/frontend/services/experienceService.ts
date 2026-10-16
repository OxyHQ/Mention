import { ClarityClient } from '@clarity.surf/sdk';
import type { Experience, ExperienceInput } from '@clarity.surf/sdk/experience';
import { CLARITY_API_URL } from '@/config';
import { oxyServices } from '@/lib/oxyServices';

const publicClarity = new ClarityClient({ baseUrl: CLARITY_API_URL });
const clarityTransport = oxyServices.createLinkedClient({
  baseURL: CLARITY_API_URL,
  enableRetry: false,
  requestTimeout: 15_000,
}).client;

const authenticatedClarity = new ClarityClient({
  baseUrl: CLARITY_API_URL,
  getAccessToken: () => oxyServices.http.getAccessToken() ?? '',
  // Keep Oxy's preflight refresh, single 401 retry and session-switch protection.
  // Clarity owns the request contract and parses its original response body.
  fetch: async (url, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get('authorization') !== `Bearer ${oxyServices.http.getAccessToken()}`) {
      throw new Error('The request session changed');
    }
    const method = init?.method;
    if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'DELETE') {
      throw new Error('Unsupported experience request');
    }
    return clarityTransport.requestAuthenticatedResponse({
      url: String(url),
      method,
      headers,
      body: init?.body ?? undefined,
      signal: init?.signal ?? undefined,
    });
  },
});

/** Clarity is the canonical store; Mention never persists a second work history. */
export const experienceService = {
  async list(userId: string, authenticated = false): Promise<Experience[]> {
    const result = await (authenticated ? authenticatedClarity : publicClarity).experience.list(
      userId,
    );
    return result.items;
  },
  create(input: ExperienceInput): Promise<Experience> {
    return authenticatedClarity.experience.create(input);
  },
  update(id: string, input: ExperienceInput): Promise<Experience> {
    return authenticatedClarity.experience.update(id, input);
  },
  async remove(id: string): Promise<void> {
    await authenticatedClarity.experience.delete(id);
  },
};
