/**
 * Broadcast red shared by every "live" affordance: the LIVE badge and End Room
 * action on the room screen, the section marker on the rooms list, and the
 * pulsing dot in the sidebar widget.
 *
 * It is a fixed status signal rather than a themed accent — it must read the
 * same in light/dark and under every color preset — so it is NOT a Bloom theme
 * token. This constant is its single source of truth; never re-type the hex.
 */
export const LIVE_INDICATOR_COLOR = '#FF4458';

/** Text/icon color that sits on top of {@link LIVE_INDICATOR_COLOR}. */
export const LIVE_INDICATOR_FOREGROUND_COLOR = '#FFFFFF';

/**
 * The blue of the verified badge, everywhere it is drawn.
 *
 * A fixed status signal, like {@link LIVE_INDICATOR_COLOR} above and for the
 * same reason: verification is a fact about the account, not an accent. It
 * cannot follow the theme's `primary`, because a profile scopes that token to
 * the PROFILE OWNER's colour preset (`BloomColorScope` in `ProfileScreen`,
 * `ChannelScreen`, `AccountInfoScreen`, `ProfileHoverCard`) — so the same badge
 * rendered pink on one profile and green on the next, and matched neither on the
 * reader's own feed. It must read the same in light/dark, under all 64 presets,
 * and over a video overlay.
 *
 * Applied as the DEFAULT of `VerifiedIcon`'s `color` prop rather than passed by
 * each caller, so a new identity surface cannot drift from it by omission — the
 * drift this constant exists to end was exactly that, twice
 * (`#1DA1F2` re-typed in `videos.tsx` and `MentionPicker.tsx`).
 */
export const VERIFIED_BADGE_COLOR = '#0095F6';
