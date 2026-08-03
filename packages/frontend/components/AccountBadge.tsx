import React, { useCallback } from 'react';
import {
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import type { AccountKind } from '@oxyhq/core';
import { ChannelIcon } from '@/assets/icons/channel-icon';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';
import type { ExternalNetwork } from '@/services/feedService';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

/**
 * The quiet marker that sits beside a name saying what KIND of account it is —
 * remote (fediverse / Bluesky) or a channel.
 *
 * INERT BY DEFAULT. A marker is a statement, not a control: it renders as a
 * plain labelled icon everywhere unless a caller explicitly hands it
 * `onExplainNetwork`. The default matters more than it looks — this component
 * appears on ~15 surfaces (every post header, every who-to-follow row, search,
 * suggestions, notifications, hover cards, member lists) and only ONE of them,
 * the profile, is a place where a reader asking "what is this?" has room for an
 * answer. A prop defaulting to interactive that each surface had to switch off
 * would be the same bug with more places to forget it, and every surface added
 * later would inherit the wrong behaviour silently.
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

interface IdentityMarkerProps extends IdentityBadgeVisualProps {
  Icon: React.ComponentType<{ size?: number; color?: string; className?: string }>;
  a11yLabel: string;
  /**
   * Opt IN to interactivity. Absent → a plain icon that cannot be tapped and
   * cannot swallow an enclosing row's press.
   */
  onExplainNetwork?: () => void;
}

/**
 * The one place that decides whether a marker is a control or a statement, and
 * the one place that computes its icon tone.
 */
function IdentityMarker({
  Icon,
  a11yLabel,
  onExplainNetwork,
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
      onExplainNetwork?.();
    },
    [onExplainNetwork],
  );

  const iconClassName = className ?? (color ? undefined : 'text-muted-foreground');
  const icon = <Icon size={size} color={color} className={iconClassName} />;

  if (!onExplainNetwork) {
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
  /** The Oxy account kind. `channel` is the only value that draws a marker. */
  kind?: AccountKind;
  /** Whether the account lives on another network. */
  isFederated?: boolean;
  /**
   * Which network, when federated. `activitypub` (default) shows the fediverse
   * icon; `atproto` (Bluesky) is NOT part of the fediverse, so it shows a named
   * network chip instead of the (misleading) generic fediverse icon.
   */
  network?: ExternalNetwork;
  /**
   * Opt IN to the fediverse explainer. Honoured ONLY by the federated marker:
   * the channel marker has no explainer to open, so it is inert on every
   * surface including a channel's own page. Wiring the fediverse dialog to a
   * channel icon is therefore not something a call site can do by mistake.
   */
  onExplainNetwork?: () => void;
}

/**
 * The ONE identity marker, chosen from the account's own state.
 *
 * Federation and kind are read here rather than at each surface on purpose: a
 * per-surface `isFederated ? … : kind === 'channel' ? … : null` is exactly the
 * shape that gets copied to four screens and updated on three.
 *
 * WHEN BOTH ARE TRUE, FEDERATION WINS AND ONLY ONE MARKER IS DRAWN. Two
 * reasons, in order:
 *
 *  1. The identity line already carries the name, the `@handle`, and up to
 *     three other markers (verified, agent, automated) before the time and the
 *     lane chip. It can afford one quiet fact about the account, and the two
 *     candidates are not equally worth the slot: "lives on another server"
 *     changes what a reader can expect (the posts arrive by federation, some
 *     interactions do not work, the handle is not ours to vouch for), whereas
 *     "is a channel" is an editorial description the page states plainly the
 *     moment it is opened.
 *  2. It is a rule for a case that does not yet exist, which is the cheapest
 *     time to fix it. Mention never asks for a kind when it resolves a remote
 *     actor — `@oxyhq/federation`'s identity bridge sends no `kind` key at all,
 *     and `NormalizedExternalActor` has no field to carry one — so every
 *     federated account lands on Oxy's default kind. A `channel` arriving with
 *     `isFederated` would therefore mean the kind came from somewhere that has
 *     not been reviewed, and the safe reading of an unreviewed claim is to
 *     believe the fact we established ourselves (we federated it) over the one
 *     we did not.
 */
export function AccountBadge({
  kind,
  isFederated,
  network = 'activitypub',
  onExplainNetwork,
  ...visual
}: AccountBadgeProps) {
  const { t } = useTranslation();

  if (isFederated) {
    if (network === 'atproto') {
      // Bluesky is not the fediverse, so a named chip rather than a glyph that
      // would claim it is. Never interactive, at any call site: the only
      // explainer that exists is about ActivityPub, so opening it here would
      // answer a question the reader did not ask.
      return (
        <View className={visual.containerClassName} style={visual.style}>
          <View className="bg-secondary rounded-full px-2 py-0.5">
            <Text className="text-muted-foreground text-xs font-medium">Bluesky</Text>
          </View>
        </View>
      );
    }
    return (
      <IdentityMarker
        {...visual}
        Icon={FediverseIcon}
        a11yLabel={t('fediverse.remoteBadge.a11yLabel')}
        onExplainNetwork={onExplainNetwork}
      />
    );
  }

  if (kind === 'channel') {
    return <IdentityMarker {...visual} Icon={ChannelIcon} a11yLabel={t('channels.badge.a11yLabel')} />;
  }

  return null;
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
      onExplainNetwork={onExplainNetwork}
    />
  );
}
