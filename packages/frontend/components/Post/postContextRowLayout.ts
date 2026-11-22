import { defineTokens } from '@oxy.so/bloom-language';
import { Platform } from 'react-native';

/**
 * The two measurements every post CONTEXT ROW shares — "Reposted by", "Pinned",
 * "Replying to", `Instagram · Threads`.
 *
 * ## Why these are a module of their own
 *
 * They were exported from `PostHeader`, which is correct about ownership and
 * wrong about weight: importing a number pulled in the whole header tree — the
 * Bloom avatar, the live-presence hook, the router — so any row component that
 * wanted the height either dragged that in or hardcoded `18` beside it.
 * Hardcoding is the dangerous half: `PostHeader` offsets the avatar down by
 * `rows × (height + gap)` to keep it level with the name row, so a second copy
 * that drifts does not misrender the row — it misaligns the AVATAR, one column
 * away from the number that caused it.
 *
 * Every consumer imports from HERE. `PostHeader` deliberately does not re-export
 * them for convenience: a constant reachable from two modules is a constant with
 * two import paths, and the next caller picks whichever one autocomplete offers.
 */

/** Gap between the context rows and the name row beneath them. */
export const HEADER_CONTENT_GAP = 4;

/**
 * Fixed height of a single context row.
 *
 * Fixed rather than intrinsic so the avatar/menu vertical offset that re-aligns
 * them with the name row stays exact and deterministic — no measurement, no
 * `onLayout`. See `headerTopOffset` in `PostHeader`.
 */
export const POST_CONTEXT_ROW_HEIGHT = 18;

/**
 * A context row's measurements as Bloom language tokens: the row's height, the
 * glyph (13pt, hung in the avatar gutter) and the gap between it and the text.
 */
export const contextRowTokens = defineTokens({
  space: { row: POST_CONTEXT_ROW_HEIGHT, iconGap: 3 },
  iconSize: { glyph: 13 },
});

/**
 * A context glyph's colour, as the owner's build drew it: its `currentColor`
 * fill took the muted ink from a class, which reached the glyph only on the web
 * (natively the class stays a raw prop of react-native-svg's Svg, so the glyph
 * keeps currentColor with no colour; an owner-build bug kept as it was, for the
 * owner to decide). On the web the muted ink is its CSS variable, handed to the
 * Svg as its `color`, which its currentColor reads.
 */
export const CONTEXT_GLYPH_COLOR: string | undefined =
  Platform.OS === 'web' ? 'var(--muted-foreground)' : undefined;
