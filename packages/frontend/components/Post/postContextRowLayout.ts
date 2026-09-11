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
 * `PostHeader` still re-exports both under their original names, so every
 * existing import keeps working and there is one definition behind them.
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
