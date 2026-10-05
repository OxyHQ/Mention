import { USER_PROFILE_COLOR_PRESETS } from '@oxy.so/contracts';
import {
  FREE_COLOR_NAMES,
  HANDLE_COLOR_NAMES,
  PREMIUM_COLOR_NAMES,
  type AppColorName,
} from '@oxy.so/bloom/theme';

/**
 * WHO MAY WEAR WHICH COLOUR — the one authority, used by the picker AND by the
 * code that applies a stored preference.
 *
 * Those two must never answer differently. When only the picker knew the rule, a
 * preset it refused to offer was still applied on the next cold boot, so the
 * paywall held for exactly as long as the user stayed on that screen. Splitting
 * the answer across two call sites is the same shape as the bug that let the
 * picker give the gated presets away in the first place.
 *
 * Bloom declares WHAT is gated (`FREE_`/`HANDLE_`/`PREMIUM_COLOR_NAMES`); this
 * decides WHETHER a given viewer clears it, because only the app knows who is
 * signed in and what they pay for.
 */
export interface ColorViewer {
  /** The viewer's handle, in any case. Absent for a signed-out viewer. */
  username?: string | null;
  mentionMono: boolean;
}

/**
 * Mention's baseline preset — what the app paints before anyone chooses, and
 * what an unentitled preference falls back to. Declared here rather than at the
 * provider so the revocation path cannot drift from the provider's default and
 * "revoke" some third colour nobody picked.
 *
 * It must be a FREE preset: Bloom's own built-in default is `oxy`, which is
 * handle-gated, and falling back to that would hand out a reserved brand colour
 * as a consolation prize.
 */
export const APP_DEFAULT_COLOR_PRESET: AppColorName = 'blue';

/**
 * A handle-gated preset is owned by the account whose handle matches its NAME —
 * `oxy` belongs to @oxy. Bloom presets must also belong to Oxy’s canonical
 * portable profile contract; an unsupported handle color cannot be saved even
 * when its handle matches.
 */
export function entitledColorNames(viewer: ColorViewer): readonly AppColorName[] {
  const handle = viewer.username?.trim().toLowerCase();
  const supported = new Set<string>(USER_PROFILE_COLOR_PRESETS);
  return [
    ...FREE_COLOR_NAMES,
    ...HANDLE_COLOR_NAMES.filter((name) => name === handle),
    ...(viewer.mentionMono ? PREMIUM_COLOR_NAMES.filter(name => name === 'mono') : []),
  ].filter(name => supported.has(name));
}

export function isColorEntitled(name: AppColorName, viewer: ColorViewer): boolean {
  return entitledColorNames(viewer).includes(name);
}

/** Oxy resolves individual and configured product sources; generic premium is not authority. */
export function colorViewerForUser(user: { username?: string | null; personalization?: { mentionMono?: { allowed: boolean; expiresAt: string | null } } } | null | undefined, now = Date.now()): ColorViewer {
  const grant = user?.personalization?.mentionMono;
  const expires = grant?.expiresAt === null ? Infinity : Date.parse(grant?.expiresAt ?? '');
  return { username: user?.username, mentionMono: grant?.allowed === true && expires > now };
}
