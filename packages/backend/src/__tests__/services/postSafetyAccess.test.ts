import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafetyDecision } from '@oxy.so/contracts';
import { postSafetyMaterial } from '../../services/contentClassification/safetyAssessment';
const { contents, assessments } = vi.hoisted(() => ({
  contents: vi.fn(),
  assessments: vi.fn(),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    safety: { contentAccessBatch: contents },
  }),
}));
vi.mock('../../db/posts/postSafetyRepository', () => ({ loadPostSafetyAssessments: assessments }));
import { loadPostSafetyDecisions } from '../../services/postSafetyAccess';
const allowed: SafetyDecision = { allowed: true, reason: 'allowed', policyVersion: '2' };
const post = (id: string, author = 'author') => ({
  id,
  oxyUserId: author,
  content: { variants: [{ source: 'author' as const, text: 'An afternoon planting trees.' }] },
});
beforeEach(() => {
  vi.clearAllMocks();
  assessments.mockResolvedValue(new Map());
  contents.mockImplementation(async ({ items }: { items: { resourceId: string }[] }) => ({
    items: items.map(({ resourceId }) => ({ resourceId, decision: allowed })),
  }));
});
describe('canonical safety for the whole hydrated graph', () => {
  it('batches unique revisions with their authors, preserving original MCP proof', async () => {
    const rows = Array.from({ length: 201 }, (_, index) =>
      post(String(index), `author-${index % 2}`),
    );
    const requester = { connectionToken: 'live-adult-connection' };
    const decisions = await loadPostSafetyDecisions([...rows, rows[0]], requester);
    expect(decisions.size).toBe(201);
    expect(contents).toHaveBeenCalledTimes(3);
    expect(contents.mock.calls.map(([input]) => input.items.length)).toEqual([100, 100, 1]);
    expect(assessments).toHaveBeenCalledTimes(1);
    expect(assessments.mock.calls[0][0]).toHaveLength(201);
    for (const [, proof] of contents.mock.calls) expect(proof).toEqual(requester);
  });
  it('uses current evidence and leaves adult allowance to Oxy', async () => {
    const current = post('current');
    assessments.mockResolvedValue(
      new Map([
        [
          current.id,
          {
            materialDigest: postSafetyMaterial(current).digest,
            rating: 'general',
            assessmentVersion: 1,
          },
        ],
      ]),
    );
    const result = await loadPostSafetyDecisions([current, post('unrated')], {
      accessToken: 'adult-session',
    });
    expect(contents.mock.calls[0][0].items).toEqual([
      {
        resourceId: 'current',
        classification: 'general',
        authorAccountId: 'author',
        audience: 'public',
        applicationAudienceAllowed: true,
      },
      {
        resourceId: 'unrated',
        classification: 'unrated',
        authorAccountId: 'author',
        audience: 'public',
        applicationAudienceAllowed: true,
      },
    ]);
    expect(result.get('unrated')?.allowed).toBe(true);
  });
  it('checks private profiles afresh and does not accept missing policy decisions', async () => {
    const rows = [post('one')];
    expect((await loadPostSafetyDecisions(rows, { accessToken: null })).get('one')?.allowed).toBe(
      true,
    );
    contents.mockResolvedValueOnce({
      items: [{ resourceId: 'one', decision: { ...allowed, allowed: false, reason: 'private' } }],
    });
    expect((await loadPostSafetyDecisions(rows, { accessToken: null })).get('one')?.reason).toBe(
      'private',
    );
    contents.mockResolvedValueOnce({ items: [] });
    expect((await loadPostSafetyDecisions(rows, { accessToken: null })).get('one')?.allowed).toBe(
      false,
    );
    contents.mockResolvedValueOnce({ items: [] });
    expect((await loadPostSafetyDecisions(rows, { accessToken: null })).get('one')?.allowed).toBe(
      false,
    );
  });
  it('honors supervised content denial even when the profile is public', async () => {
    contents.mockResolvedValueOnce({
      items: [
        { resourceId: 'one', decision: { ...allowed, allowed: false, reason: 'unrated_content' } },
      ],
    });
    const result = await loadPostSafetyDecisions([post('one')], { accessToken: 'child-session' });
    expect(result.get('one')).toMatchObject({ allowed: false, reason: 'unrated_content' });
  });
  it('does not turn a policy outage into public access', async () => {
    contents.mockRejectedValueOnce(new Error('Oxy unavailable'));
    await expect(loadPostSafetyDecisions([post('one')], { accessToken: null })).rejects.toThrow(
      'Oxy unavailable',
    );
  });
});
