// `mock`-prefixed on purpose: jest hoists `jest.mock` above these declarations
// and rejects a factory that closes over anything else.
const mockAuthenticated = {
  get: jest.fn(),
  post: jest.fn(),
};

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockAuthenticated.get(...args),
    post: (...args: unknown[]) => mockAuthenticated.post(...args),
  },
}));

import { communityNotesService } from '@/services/communityNotesService';

/**
 * The wire contract for community notes, and the two things about it that are
 * easy to get wrong without noticing.
 *
 * The queue is a POST even though it reads like a list — asking for it is what
 * ISSUES the assignments a rating is checked against — and every list endpoint
 * has to survive a body with no `entries` at all, because "the integration is
 * off" and "you have no notes" arrive as the same empty answer.
 */
describe('communityNotesService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads availability as a plain boolean, never a truthy body', async () => {
    mockAuthenticated.get.mockResolvedValue({ data: { enabled: false } });

    await expect(communityNotesService.availability()).resolves.toBe(false);
    expect(mockAuthenticated.get).toHaveBeenCalledWith('/community-notes/availability');
  });

  it('sends a note with the sources the writer cited', async () => {
    mockAuthenticated.post.mockResolvedValue({ data: { note: { id: 'n1', status: 'needs_ratings' } } });

    const note = await communityNotesService.write({
      postId: 'p1',
      text: 'context',
      sourceUrls: ['https://example.org/s'],
    });

    expect(mockAuthenticated.post).toHaveBeenCalledWith('/community-notes', {
      postId: 'p1',
      text: 'context',
      sourceUrls: ['https://example.org/s'],
    });
    expect(note.id).toBe('n1');
  });

  it('escapes the note id it puts in a path', async () => {
    mockAuthenticated.post.mockResolvedValue({ data: { note: { id: 'n/1' } } });

    await communityNotesService.withdraw('n/1');

    expect(mockAuthenticated.post).toHaveBeenCalledWith('/community-notes/n%2F1/withdraw');
  });

  it('sends a rating together with the reasons that explain it', async () => {
    mockAuthenticated.post.mockResolvedValue({ data: {} });

    await communityNotesService.rate('n1', 'not_helpful', ['incorrect']);

    expect(mockAuthenticated.post).toHaveBeenCalledWith('/community-notes/n1/ratings', {
      rating: 'not_helpful',
      reasons: ['incorrect'],
    });
  });

  it('asks for the rating queue with a POST, because asking issues the assignments', async () => {
    mockAuthenticated.post.mockResolvedValue({ data: { entries: [{ note: { id: 'n1' }, post: { id: 'p1' } }] } });

    const entries = await communityNotesService.toRate();

    expect(mockAuthenticated.post).toHaveBeenCalledWith('/community-notes/to-rate');
    expect(entries).toHaveLength(1);
  });

  it.each([
    ['mine', () => communityNotesService.mine()],
    ['ratings', () => communityNotesService.rated()],
  ])('reads /%s as an empty list when the body carries none', async (_label, call) => {
    mockAuthenticated.get.mockResolvedValue({ data: {} });

    await expect(call()).resolves.toEqual([]);
  });

  it('reads the viewer’s own notes with the posts they are about', async () => {
    mockAuthenticated.get.mockResolvedValue({
      data: { entries: [{ note: { id: 'n1', status: 'not_shown' }, post: { id: 'p1' } }] },
    });

    const entries = await communityNotesService.mine();

    expect(mockAuthenticated.get).toHaveBeenCalledWith('/community-notes/mine');
    expect(entries[0]?.note.status).toBe('not_shown');
    expect(entries[0]?.post.id).toBe('p1');
  });
});
