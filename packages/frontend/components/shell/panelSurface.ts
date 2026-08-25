/**
 * WHERE A ROUTE ACTUALLY PAINTS, for the code that has to aim at it.
 *
 * The shell's centre column is emergent: `shell:flex-[2.2]` inside a
 * `shell:max-w-[950px]` row, with no constant anywhere that says how wide it
 * ends up. Measured, it lands at 592px on every desktop width and at the full
 * window on mobile. Anything that needs to target a route BEFORE that route has
 * mounted — a media flight aiming at the reel, say — cannot ask the route and
 * cannot read a number that does not exist.
 *
 * It can ask the panel, because the panel is already on screen and every route
 * paints inside it. This keeps the NODE rather than a measured rect, the same
 * shape as Bloom's anchor registry, so a measurement is always taken now rather
 * than replayed from whenever the layout last changed.
 *
 * Vertical extent is deliberately NOT part of this: a fullscreen route draws
 * the whole window height while the panel keeps its 8px gutter, so the caller
 * pairs this width with whatever height its destination really uses.
 */
let panelSurface: { measureInWindow(cb: (x: number, y: number, w: number, h: number) => void): void } | null = null;

export function registerPanelSurface(node: typeof panelSurface): void {
    panelSurface = node;
}

/** The panel's window rect, or `null` when nothing has registered or it has no area. */
export function measurePanelSurface(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const node = panelSurface;
    if (!node) return Promise.resolve(null);
    return new Promise((resolve) => {
        node.measureInWindow((x, y, width, height) => {
            resolve(width > 0 && height > 0 ? { x, y, width, height } : null);
        });
    });
}
