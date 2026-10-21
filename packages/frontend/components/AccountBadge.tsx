import type React from 'react';
import { useCallback } from 'react';
import {
  Pressable,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import type { AccountKind } from '@oxy.so/core';
import { RiBuildingLine } from '@oxy.so/bloom/icons/RiBuildingLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { isMentionChannel } from '@mention/shared-types/profileUrls';
import { ChannelIcon } from '@/assets/icons/channel-icon';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

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
  /** Icon size in px. Defaults to 15 (inline-with-text size). */
  size?: number;
  /** Icon color class. Defaults to a muted foreground tone when no `color` is set. */
  className?: string;
  /** Explicit fill color; overrides `className`. Used where callers pass a resolved theme color. */
  color?: string;
  /** Layout class for the wrapper (e.g. `self-center ml-1` at a call site). */
  containerClassName?: string;
  /** Style for the wrapper (e.g. the baseline-nudge transform in UserName). */
  style?: StyleProp<ViewStyle>;
}

/** What a marker's icon is drawn with. */
type MarkerIcon = React.ComponentType<{ size?: number; color?: string; className?: string }>;

/** A Bloom icon, drawn at a marker's size and tone. */
function bloomMarkerIcon(Icon: typeof RiGroupLine): MarkerIcon {
  return function BloomMarkerIcon({ size, color, className }) {
    return <Icon width={size} height={size} fill={color} className={className} />;
  };
}

/**
 * The REMOTE kinds that draw their own marker instead of the fediverse one, with
 * the i18n key of what a screen reader hears. The kind is Oxy's, read from the
 * remote actor's AS2 type by `@oxy.so/federation`'s actor-type table: a `Group`
 * is a `community`, an `Organization` an `organization`, a `Service` or an
 * `Application` a `bot` — the same distinctions Mastodon draws as its "Group"
 * and "Automated" badges. A remote `channel` (a PeerTube channel) is not a
 * Mention channel, so it keeps the fediverse marker.
 */
const REMOTE_KIND_MARKERS = {
  community: { Icon: bloomMarkerIcon(RiGroupLine), labelKey: 'accountBadge.community' },
  organization: { Icon: bloomMarkerIcon(RiBuildingLine), labelKey: 'accountBadge.organization' },
  bot: { Icon: bloomMarkerIcon(RiRobot2Line), labelKey: 'accountBadge.bot' },
} as const satisfies Partial<Record<AccountKind, { Icon: MarkerIcon; labelKey: string }>>;

function remoteKindMarker(kind: AccountKind | undefined) {
  return kind && kind in REMOTE_KIND_MARKERS
    ? REMOTE_KIND_MARKERS[kind as keyof typeof REMOTE_KIND_MARKERS]
    : undefined;
}

interface IdentityMarkerProps extends IdentityBadgeVisualProps {
  Icon: MarkerIcon;
  a11yLabel: string;
  /**
   * Opt IN to interactivity. Absent → a plain icon that cannot be tapped and
   * cannot swallow an enclosing row's press.
   *
   * Deliberately named for what it DOES here rather than for which explainer it
   * opens: each branch of {@link AccountBadge} hands it that branch's own
   * handler, and this component is the shared mechanism, not the choice.
   */
  onExplain?: () => void;
}

/**
 * The one place that decides whether a marker is a control or a statement, and
 * the one place that computes its icon tone.
 */
function IdentityMarker({
  Icon,
  a11yLabel,
  onExplain,
  size = 15,
  className,
  color,
  containerClassName,
  style,
}: IdentityMarkerProps) {
  const handlePress = useCallback(
    (event?: GestureResponderEvent) => {
      // Only reachable when a caller opted in. The marker still sits inside an
      // identity line that a parent may make pressable, so an opted-in marker
      // keeps its tap to itself rather than also firing the row's navigation.
      event?.stopPropagation?.();
      onExplain?.();
    },
    [onExplain],
  );

  const iconClassName = className ?? (color ? undefined : 'text-muted-foreground');
  const icon = <Icon size={size} color={color} className={iconClassName} />;

  if (!onExplain) {
    // `image` rather than no role: the marker carries meaning a sighted reader
    // gets from the glyph, so it stays in the accessibility tree — it simply
    // stops being announced as something that can be activated.
    return (
      <View
        className={containerClassName}
        style={style}
        accessibilityRole="image"
        accessibilityLabel={a11yLabel}
      >
        {icon}
      </View>
    );
  }

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      hitSlop={HIT_SLOP_MD}
      className={containerClassName}
      style={style}
    >
      {icon}
    </Pressable>
  );
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
 *  - A remote community, organization or bot draws ITS KIND's marker
 *    ({@link REMOTE_KIND_MARKERS}). The kind is the fact that changes how the row
 *    reads — a community's posts are its members', a bot is automated — while
 *    "lives on another server" is already printed in its `@name@instance`
 *    handle. The kind is Oxy's own record of the remote actor's type, so it is a
 *    reviewed claim, not one an instance can make up for a local account.
 *  - Every other remote account draws the fediverse marker.
 *
 * A local organization, project or bot draws nothing: its page names what it is
 * (`AccountCategoryLine`), and this line is unchanged for it.
 */
export function AccountBadge(props: AccountBadgeProps) {
  // Most accounts draw no marker at all, and this sits in every post header
  // (twice). Deciding that BEFORE any hook keeps the common case at zero hook
  // slots — `useTranslation` alone is a dozen, plus an i18n listener, per
  // instance (#1103).
  if (!props.isFederated && !isMentionChannel(props)) return null;
  return <AccountBadgeMarker {...props} />;
}

function AccountBadgeMarker({
  kind,
  isFederated,
  onExplainNetwork,
  onExplainChannel,
  ...visual
}: AccountBadgeProps) {
  const { t } = useTranslation();

  if (isMentionChannel({ kind, isFederated })) {
    return (
      <IdentityMarker
        {...visual}
        Icon={ChannelIcon}
        a11yLabel={t('channels.badge.a11yLabel')}
        onExplain={onExplainChannel}
      />
    );
  }

  const remoteKind = remoteKindMarker(kind);
  return (
    <IdentityMarker
      {...visual}
      Icon={remoteKind?.Icon ?? FediverseIcon}
      a11yLabel={t(remoteKind?.labelKey ?? 'fediverse.remoteBadge.a11yLabel')}
      onExplain={onExplainNetwork}
    />
  );
}

/**
 * The viewer's OWN-profile fediverse-sharing marker: the fediverse icon next to
 * the handle when the viewer has sharing on.
 *
 * A different fact from {@link AccountBadge} — it describes a SETTING the viewer
 * controls, not what the account is — but it obeys the same default, so there is
 * one rule about badge interactivity in this file rather than two.
 */
export function FediverseSharingBadge({
  onExplainNetwork,
  ...visual
}: IdentityBadgeVisualProps & { onExplainNetwork?: () => void }) {
  const { t } = useTranslation();
  return (
    <IdentityMarker
      {...visual}
      Icon={FediverseIcon}
      a11yLabel={t('fediverse.badge.a11yLabel')}
      onExplain={onExplainNetwork}
    />
  );
}
