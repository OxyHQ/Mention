import type { TrendGraphEdgeDTO, TrendGraphNodeDTO } from '@mention/shared-types';
import { buildTrendTree } from '../trendGraphTree';

const node = (
  term: string,
  volume: number,
  story?: string,
): TrendGraphNodeDTO => ({
  term,
  volume,
  authorCount: 3,
  languages: ['en'],
  regions: [],
  ...(story ? { story } : {}),
});

describe('buildTrendTree', () => {
  it('roots each story at its representative and hangs the merged terms under it', () => {
    const tree = buildTrendTree(
      [
        node('unitedstates', 19, 'unitedstates'),
        node('us', 18, 'unitedstates'),
        node('usa', 12, 'unitedstates'),
        node('news', 10),
      ],
      [],
    );

    expect(tree.stories).toHaveLength(1);
    expect(tree.stories[0].node.term).toBe('unitedstates');
    expect(tree.stories[0].children.map((child) => child.node.term)).toEqual(['us', 'usa']);
    expect(tree.ungrouped.map((entry) => entry.node.term)).toEqual(['news']);
  });

  it('never repeats a term at the top level once it has a parent', () => {
    // One term, one place in the tree. A member listed again beside its own
    // story would double every count a reader adds up by eye.
    const tree = buildTrendTree(
      [node('ukraine', 40, 'ukraine'), node('kyiv', 10, 'ukraine')],
      [],
    );

    const roots = [...tree.stories, ...tree.ungrouped].map((entry) => entry.node.term);
    expect(roots).toEqual(['ukraine']);
  });

  it('hangs an unmerged edge under BOTH terms it failed to join', () => {
    // A near miss explains each of its endpoints, so it belongs under each.
    const tree = buildTrendTree(
      [node('news', 10), node('sports', 13)],
      [{ a: 'news', b: 'sports', posts: 4, linked: false }],
    );

    const bySlug = new Map(tree.ungrouped.map((entry) => [entry.node.term, entry.related]));
    expect(bySlug.get('news')).toEqual([{ term: 'sports', posts: 4 }]);
    expect(bySlug.get('sports')).toEqual([{ term: 'news', posts: 4 }]);
  });

  it('leaves merged edges out of the related list', () => {
    // A merged pair is already shown as parent and child; repeating it as a
    // "related" leaf would say the same thing twice in two different shapes.
    const tree = buildTrendTree(
      [node('ukraine', 40, 'ukraine'), node('kyiv', 10, 'ukraine')],
      [{ a: 'kyiv', b: 'ukraine', posts: 8, linked: true }],
    );

    expect(tree.stories[0].related).toEqual([]);
    expect(tree.stories[0].children[0].related).toEqual([]);
  });

  it('orders everything by volume, and breaks ties by term', () => {
    const tree = buildTrendTree(
      [node('b', 5), node('a', 5), node('c', 9)],
      [],
    );

    expect(tree.ungrouped.map((entry) => entry.node.term)).toEqual(['c', 'a', 'b']);
  });

  it('carries a label onto a relation when the other end has one', () => {
    const tree = buildTrendTree(
      [node('news', 10), { ...node('sports', 13), displayName: 'Sports' }],
      [{ a: 'news', b: 'sports', posts: 4, linked: false }],
    );

    const news = tree.ungrouped.find((entry) => entry.node.term === 'news');
    expect(news?.related[0].displayName).toBe('Sports');
  });
});
