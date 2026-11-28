import { ClarityClient, clarityForOxySession } from '@clarity.surf/sdk';
import type { Experience, ExperienceInput } from '@clarity.surf/sdk/experience';
import { CLARITY_API_URL } from '@/config';
import { oxyServices } from '@/lib/oxyServices';

const publicClarity = new ClarityClient({ baseUrl: CLARITY_API_URL });
const authenticatedClarity = clarityForOxySession(oxyServices, {
  baseUrl: CLARITY_API_URL,
  timeoutMs: 15_000,
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
