/**
 * Touch-target padding for icon-sized affordances.
 *
 * Three scalars, deliberately. React Native expands the scalar form of `hitSlop`
 * symmetrically on all four edges, so it is both shorter than the object form and
 * impossible to leave accidentally lopsided — a hit region that reaches further
 * on one edge silently steals taps aimed at whatever sits there.
 *
 * An asymmetric `hitSlop` is still the right answer where the geometry is
 * genuinely asymmetric (two halves of one pill that must not overlap each other).
 * Those stay written out inline, with a comment saying why.
 */

/** Dense chrome inside an already-padded row, where a larger region would collide. */
export const HIT_SLOP_SM = 6;

/** Default for a standalone icon affordance. */
export const HIT_SLOP_MD = 8;

/** A bare icon with no padding of its own, carrying the whole target itself. */
export const HIT_SLOP_LG = 12;
