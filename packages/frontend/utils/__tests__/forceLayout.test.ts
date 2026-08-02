import { layoutGraph, type LayoutEdge, type LayoutNode } from '../forceLayout';

const nodes = (ids: string[]): LayoutNode[] => ids.map((id, index) => ({ id, weight: index }));

describe('layoutGraph', () => {
  it('draws the same graph the same way every time', () => {
    // A random seed makes the same data draw a different picture on every
    // render: filtering and clearing the filter would not return the reader to
    // a graph they recognise, and two people comparing screens would be
    // comparing noise.
    const input = nodes(['a', 'b', 'c', 'd']);
    const edges: LayoutEdge[] = [
      { source: 'a', target: 'b', strength: 0.9 },
      { source: 'c', target: 'd', strength: 0.4 },
    ];

    expect(layoutGraph(input, edges)).toEqual(layoutGraph(input, edges));
  });

  it('keeps every position inside the unit box', () => {
    // The simulation has no walls, so this is the fit-afterwards step working.
    const positions = layoutGraph(
      nodes(['a', 'b', 'c', 'd', 'e', 'f']),
      [
        { source: 'a', target: 'b', strength: 1 },
        { source: 'b', target: 'c', strength: 1 },
        { source: 'd', target: 'e', strength: 0.2 },
      ],
    );

    expect(positions).toHaveLength(6);
    for (const position of positions) {
      expect(position.x).toBeGreaterThanOrEqual(0);
      expect(position.x).toBeLessThanOrEqual(1);
      expect(position.y).toBeGreaterThanOrEqual(0);
      expect(position.y).toBeLessThanOrEqual(1);
      expect(Number.isFinite(position.x) && Number.isFinite(position.y)).toBe(true);
    }
  });

  it('settles linked nodes closer than unlinked ones', () => {
    const positions = layoutGraph(nodes(['a', 'b', 'c']), [
      { source: 'a', target: 'b', strength: 1 },
    ]);
    const at = (id: string) => positions.find((position) => position.id === id)!;
    const distance = (left: string, right: string) =>
      Math.hypot(at(left).x - at(right).x, at(left).y - at(right).y);

    expect(distance('a', 'b')).toBeLessThan(distance('a', 'c'));
    expect(distance('a', 'b')).toBeLessThan(distance('b', 'c'));
  });

  it('handles the shapes that divide by zero', () => {
    // One node has no span to normalize against; an edge naming a node that is
    // not in the graph has no position to pull.
    expect(layoutGraph([], [])).toEqual([]);
    expect(layoutGraph(nodes(['solo']), [])).toEqual([{ id: 'solo', x: 0.5, y: 0.5 }]);

    const dangling = layoutGraph(nodes(['a', 'b']), [
      { source: 'a', target: 'ghost', strength: 1 },
      { source: 'a', target: 'a', strength: 1 },
    ]);
    for (const position of dangling) {
      expect(Number.isFinite(position.x) && Number.isFinite(position.y)).toBe(true);
    }
  });
});
