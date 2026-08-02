/**
 * Lay a graph out by simulating springs and repulsion — a Fruchterman-Reingold
 * embedding, run to completion once rather than animated.
 *
 * Deterministic on purpose. The obvious way to seed a force layout is random
 * placement, and it makes the same data draw a different picture on every
 * render: a reader who filters and clears the filter would not recognise the
 * graph they were just looking at, and two people comparing screens would be
 * comparing noise. Positions here are a pure function of the graph, so the same
 * batch always draws the same shape.
 *
 * Run synchronously — no animation loop, no shared values, no frame callbacks.
 * The graphs this serves are tens of nodes, the whole simulation is well under a
 * frame, and an animated version would buy a settling wobble at the price of
 * every failure mode Reanimated has on web.
 */

export interface LayoutNode {
  id: string;
  /** Relative pull weight. Larger nodes settle nearer the middle. */
  weight: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
  /** Relative pull, 0–1. A stronger link sits shorter. */
  strength: number;
}

export interface LayoutPosition {
  id: string;
  /** 0–1 within the drawing box, ready to multiply by a viewport size. */
  x: number;
  y: number;
}

/**
 * Iterations scale INVERSELY with node count, so total work stays roughly
 * linear in `n` even though each pass is quadratic. A big graph converges
 * coarsely and a small one precisely, which is the right trade: the small graph
 * is the one whose exact shape a reader studies.
 */
function iterationsFor(count: number): number {
  return Math.max(40, Math.min(200, Math.round(3000 / Math.max(count, 1))));
}

/**
 * Deterministic starting ring.
 *
 * The golden angle spreads successive nodes around the circle instead of
 * placing neighbours adjacently, which stops the first pass from having to
 * untangle a spiral of its own making.
 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function layoutGraph(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): LayoutPosition[] {
  if (nodes.length === 0) return [];
  if (nodes.length === 1) return [{ id: nodes[0].id, x: 0.5, y: 0.5 }];

  const count = nodes.length;
  const index = new Map(nodes.map((node, position) => [node.id, position]));
  const x = new Float64Array(count);
  const y = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    const radius = 0.4 * Math.sqrt((i + 0.5) / count);
    const angle = i * GOLDEN_ANGLE;
    x[i] = 0.5 + radius * Math.cos(angle);
    y[i] = 0.5 + radius * Math.sin(angle);
  }

  // Ideal edge length for a unit square holding `count` nodes.
  const k = Math.sqrt(1 / count);
  const iterations = iterationsFor(count);
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);

  for (let step = 0; step < iterations; step++) {
    dx.fill(0);
    dy.fill(0);

    // Repulsion: every node pushes every other, so unconnected parts of the
    // graph separate instead of piling up at the origin.
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let deltaX = x[i] - x[j];
        let deltaY = y[i] - y[j];
        let distance = Math.hypot(deltaX, deltaY);
        if (distance < 1e-6) {
          // Exactly coincident nodes have no direction to separate along. Nudge
          // them apart along a fixed axis chosen by index, so the tie is broken
          // the same way on every run.
          deltaX = (i % 2 === 0 ? 1 : -1) * 1e-4;
          deltaY = (j % 2 === 0 ? 1 : -1) * 1e-4;
          distance = Math.hypot(deltaX, deltaY);
        }
        const force = (k * k) / distance;
        const unitX = (deltaX / distance) * force;
        const unitY = (deltaY / distance) * force;
        dx[i] += unitX;
        dy[i] += unitY;
        dx[j] -= unitX;
        dy[j] -= unitY;
      }
    }

    // Attraction along edges, scaled by the link's own strength.
    for (const edge of edges) {
      const source = index.get(edge.source);
      const target = index.get(edge.target);
      if (source === undefined || target === undefined || source === target) continue;

      const deltaX = x[source] - x[target];
      const deltaY = y[source] - y[target];
      const distance = Math.max(Math.hypot(deltaX, deltaY), 1e-6);
      const force = ((distance * distance) / k) * Math.max(edge.strength, 0.05);
      const unitX = (deltaX / distance) * force;
      const unitY = (deltaY / distance) * force;
      dx[source] -= unitX;
      dy[source] -= unitY;
      dx[target] += unitX;
      dy[target] += unitY;
    }

    // Cooling: early passes move far and rearrange, later ones only settle.
    const temperature = 0.1 * (1 - step / iterations);
    for (let i = 0; i < count; i++) {
      // A heavier node moves less, so the terms carrying the most posts end up
      // anchoring the picture rather than being flung by their many edges.
      const inertia = 1 / (1 + Math.max(nodes[i].weight, 0));
      const length = Math.max(Math.hypot(dx[i], dy[i]), 1e-9);
      const capped = Math.min(length, temperature);
      x[i] += (dx[i] / length) * capped * inertia;
      y[i] += (dy[i] / length) * capped * inertia;
    }
  }

  return normalize(nodes, x, y);
}

/**
 * Fit the settled positions into the unit box.
 *
 * The simulation has no walls — clamping to the box during it would flatten
 * whole clusters against an edge — so the drawing is scaled to fit afterwards.
 * A degenerate axis (every node on one line) maps to the middle rather than
 * dividing by zero.
 */
function normalize(
  nodes: readonly LayoutNode[],
  x: Float64Array,
  y: Float64Array,
): LayoutPosition[] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < nodes.length; i++) {
    minX = Math.min(minX, x[i]);
    maxX = Math.max(maxX, x[i]);
    minY = Math.min(minY, y[i]);
    maxY = Math.max(maxY, y[i]);
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  return nodes.map((node, i) => ({
    id: node.id,
    x: spanX > 1e-9 ? (x[i] - minX) / spanX : 0.5,
    y: spanY > 1e-9 ? (y[i] - minY) / spanY : 0.5,
  }));
}
