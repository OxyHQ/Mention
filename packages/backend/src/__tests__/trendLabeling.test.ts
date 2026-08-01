import { describe, it, expect, vi, beforeEach } from 'vitest';

const aliaJSON = vi.fn();
const isAliaEnabled = vi.fn(() => true);

vi.mock('../utils/alia', () => ({
  aliaJSON: (...args: unknown[]) => aliaJSON(...args),
  isAliaEnabled: () => isAliaEnabled(),
}));

const { fallbackTrendLabel, labelTrends } = await import('../services/trending/trendLabeling');

beforeEach(() => {
  vi.clearAllMocks();
  isAliaEnabled.mockReturnValue(true);
});

const request = (term: string) => ({ term, excerpts: [`a post about ${term}`] });

describe('fallbackTrendLabel', () => {
  it('title-cases the term and files it under other', () => {
    expect(fallbackTrendLabel('todd blanche')).toEqual({
      displayName: 'Todd Blanche',
      category: 'other',
    });
  });
});

describe('labelTrends — totality', () => {
  it('returns an entry for every requested term even when the model answers for none', async () => {
    aliaJSON.mockResolvedValue({ trends: [] });
    const labels = await labelTrends([request('fifa'), request('orioles')]);
    expect([...labels.keys()].sort()).toEqual(['fifa', 'orioles']);
  });

  it('never calls the model when labelling is unconfigured', async () => {
    isAliaEnabled.mockReturnValue(false);
    const labels = await labelTrends([request('fifa')]);
    expect(aliaJSON).not.toHaveBeenCalled();
    expect(labels.get('fifa')).toEqual({ displayName: 'Fifa', category: 'other' });
  });

  it('never calls the model for an empty request list', async () => {
    expect((await labelTrends([])).size).toBe(0);
    expect(aliaJSON).not.toHaveBeenCalled();
  });
});

describe('labelTrends — the model answer', () => {
  it('applies a well-formed label and category', async () => {
    aliaJSON.mockResolvedValue({
      trends: [{ term: 'orioles', displayName: 'Kremer Trade', category: 'sports' }],
    });
    const labels = await labelTrends([request('orioles')]);
    expect(labels.get('orioles')).toEqual({ displayName: 'Kremer Trade', category: 'sports' });
  });

  it('matches entries back by TERM, not by position', async () => {
    aliaJSON.mockResolvedValue({
      trends: [
        { term: 'orioles', displayName: 'Kremer Trade', category: 'sports' },
        { term: 'fifa', displayName: 'FIFA Corruption', category: 'news' },
      ],
    });
    // Requested in the opposite order to the answer.
    const labels = await labelTrends([request('fifa'), request('orioles')]);
    expect(labels.get('fifa')?.displayName).toBe('FIFA Corruption');
    expect(labels.get('orioles')?.displayName).toBe('Kremer Trade');
  });

  it('ignores an entry for a term nobody asked about', async () => {
    aliaJSON.mockResolvedValue({
      trends: [{ term: 'invented', displayName: 'Invented Story', category: 'news' }],
    });
    const labels = await labelTrends([request('fifa')]);
    expect(labels.has('invented')).toBe(false);
    expect(labels.get('fifa')?.displayName).toBe('Fifa');
  });

  it('degrades an unknown category to other while keeping the name', async () => {
    aliaJSON.mockResolvedValue({
      trends: [{ term: 'fifa', displayName: 'FIFA Corruption', category: 'Entertainment' }],
    });
    expect(await labelTrends([request('fifa')])).toEqual(
      new Map([['fifa', { displayName: 'FIFA Corruption', category: 'other' }]]),
    );
  });

  it('rejects a name that is a sentence rather than a label', async () => {
    aliaJSON.mockResolvedValue({
      trends: [{ term: 'fifa', displayName: 'x'.repeat(200), category: 'news' }],
    });
    expect((await labelTrends([request('fifa')])).get('fifa')?.displayName).toBe('Fifa');
  });

  it('rejects a non-string name', async () => {
    aliaJSON.mockResolvedValue({ trends: [{ term: 'fifa', displayName: 42, category: 'news' }] });
    expect((await labelTrends([request('fifa')])).get('fifa')?.displayName).toBe('Fifa');
  });
});

describe('labelTrends — failure is invisible to the reader', () => {
  it('falls back for every term when the model throws', async () => {
    aliaJSON.mockRejectedValue(new Error('upstream down'));
    const labels = await labelTrends([request('fifa'), request('orioles')]);
    expect(labels.get('fifa')).toEqual({ displayName: 'Fifa', category: 'other' });
    expect(labels.get('orioles')).toEqual({ displayName: 'Orioles', category: 'other' });
  });

  it('falls back when the answer has no trends array at all', async () => {
    aliaJSON.mockResolvedValue({});
    expect((await labelTrends([request('fifa')])).get('fifa')?.displayName).toBe('Fifa');
  });
});
