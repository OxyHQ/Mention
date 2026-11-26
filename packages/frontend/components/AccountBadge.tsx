import { useTranslation } from 'react-i18next';
import type { AccountKind } from '@oxy.so/core';
import { isMentionChannel } from '@mention/shared-types/profileUrls';
import { RiFediverseLine } from '@oxy.so/bloom/icons/RiFediverseLine';
import { RiMegaphoneLine } from '@oxy.so/bloom/icons/RiMegaphoneLine';
import {
  Icon,
  type IconComponent,
  type IconSizeToken,
  type ViewModifier,
  VStack,
  view,
} from '@oxy.so/bloom-language';

/**
 * The quiet marker that sits beside a name saying what KIND of account it is —
 * remote (and, for a remote community, organization or bot, which kind) or a
 * Mention channel.
 *
 * EVERY remote account draws the SAME fediverse icon, whichever network it
 * lives on (ActivityPub, including bridged X and Instagram accounts; Instagram
 * read through the Graph API; Bluesky). A per-network chip is not drawn
 * anywhere: the marker says "not an Oxy account", and the account's About
 * screen names the network for a reader who asks.
 *
 * INERT BY DEFAULT. A marker is a statement, not a control: it renders as a
 * plain labelled icon everywhere unless a caller explicitly hands it the
 * handler for the marker it is drawing — `onExplainNetwork` for the federated
 * one, `onExplainChannel` for the channel one. The default matters more than it
 * looks — this component appears on ~15 surfaces (every post header, every
 * who-to-follow row, search, suggestions, notifications, hover cards, member
 * lists) and only the account's OWN page is a place where a reader asking "what
 * is this?" has room for an answer. A prop defaulting to interactive that each
 * surface had to switch off would be the same bug with more places to forget
 * it, and every surface added later would inherit the wrong behaviour silently.
 *
 * The two handlers are separate props rather than one, and that is the point
 * rather than an accident of naming: each is read by exactly one branch below,
 * so no call site can wire the fediverse explainer to a channel icon or the
 * channel explainer to a remote account. One prop covering both would put that
 * mistake back within reach of every surface that draws a marker.
 *
 * Being inert is also what keeps the marker from stealing the row's tap: on a
 * post row or a who-to-follow card the whole row navigates, and a nested
 * pressable consumed taps aimed near the name.
 */

/** Presentation shared by every marker below. */
interface IdentityBadgeVisualProps {
  /** Icon size. Defaults to 15 (inline-with-text size). */
  size?: IconSizeToken;
  /** Icon ink: the theme's foreground, or (the default) its muted foreground. */
  tone?: 'foreground' | 'muted';
  /** The caller's placement of the marker (e.g. the baseline nudge in UserName). */
  look?: ViewModifier;
}

/**
 * The one place that decides whether a marker is a control or a statement, and
 * the one place that computes its icon tone.
 *
 * `onExplain` opts IN to interactivity. Absent: a plain icon that cannot be
 * tapped and cannot swallow an enclosing row's press. It is named for what it
 * DOES here rather than for which explainer it opens: each branch of
 * {@link AccountBadge} hands it that branch's own handler, and this is the shared
 * mechanism, not the choice.
 */
function identityMarker(
  glyph: IconComponent,
  a11yLabel: string,
  onExplain: (() => void) | undefined,
  { size = '15', tone, look }: IdentityBadgeVisualProps,
) {
  const marker = VStack(
    Icon(glyph)
      .size(size)
      .foreground(tone === 'foreground' ? 'foreground' : 'muted'),
  ).label(a11yLabel);

  if (!onExplain) {
    // `image` rather than no role: the marker carries meaning a sighted reader
    // gets from the glyph, so it stays in the accessibility tree — it simply
    // stops being announced as something that can be activated.
    return marker.role('image').modifier(look);
  }

  return marker
    .onPress((event) => {
      // Only reachable when a caller opted in. The marker still sits inside an
      // identity line that a parent may make pressable, so an opted-in marker
      // keeps its tap to itself rather than also firing the row's navigation.
      event?.stopPropagation?.();
      onExplain();
    })
    .role('button')
    .hitSlop('md')
    .modifier(look);
}

export interface AccountBadgeProps extends IdentityBadgeVisualProps {
  /**
   * The Oxy account kind. A local `channel` draws the channel marker; a remote
   * `community`, `organization` or `bot` draws its own marker.
   */
  kind?: AccountKind;
  /** Whether the account lives on another network (any network). */
  isFederated?: boolean;
  /**
   * Opt IN to the fediverse explainer. Honoured ONLY by the remote markers.
   * Passing it alongside a Mention channel does nothing, so wiring the fediverse
   * dialog to a channel icon is not something a call site can do by mistake.
   */
  onExplainNetwork?: () => void;
  /**
   * Opt IN to the channel explainer. Honoured ONLY by the channel marker, and
   * only the channel's own page passes it — a channel marker beside a name in a
   * post header, a who-to-follow row or a search result stays a statement,
   * because those rows are already a tap that goes somewhere.
   */
  onExplainChannel?: () => void;
}

/**
 * The ONE identity marker, chosen from the account's own state.
 *
 * Federation and kind are read here rather than at each surface on purpose: a
 * per-surface `isFederated ? … : kind === 'channel' ? … : null` is exactly the
 * shape that gets copied to four screens and updated on three.
 *
 * ONE MARKER, NEVER TWO. The identity line already carries the name, the
 * `@handle`, and up to three other markers (verified, agent, automated) before
 * the time and the lane chip, so it can afford one quiet fact about the account:
 *
 *  - A Mention channel ({@link isMentionChannel}) draws the channel marker. A
 *    channel is a local account, so it never competes with the fediverse one.
 *  - Every remote account draws the fediverse marker, whatever its kind: a bot
 *    or a community is not given an icon of its own.
 *
 * A local organization, project or bot draws nothing: its page names what it is
 * (`AccountCategoryLine`), and this line is unchanged for it.
 */
export function AccountBadge(props: AccountBadgeProps) {
  // Most accounts draw no marker at all, and this sits in every post header
  // (twice). Deciding that BEFORE any view keeps the common case at no fiber and
  // zero hook slots — `useTranslation` alone is a dozen, plus an i18n listener,
  // per instance (#1103).
  if (!props.isFederated && !isMentionChannel(props)) return null;
  return AccountBadgeMarker(props);
}

const AccountBadgeMarker = view(function AccountBadgeMarker({
  kind,
  isFederated,
  onExplainNetwork,
  onExplainChannel,
  ...visual
}: AccountBadgeProps) {
  const { t } = useTranslation();

  if (isMentionChannel({ kind, isFederated })) {
    return identityMarker(RiMegaphoneLine, t('channels.badge.a11yLabel'), onExplainChannel, visual);
  }

  return identityMarker(
    RiFediverseLine,
    t('fediverse.remoteBadge.a11yLabel'),
    onExplainNetwork,
    visual,
  );
});
