import React, { useCallback } from 'react';
import {
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PointerEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';
import { showFediverseInfo } from './FediverseInfoDialog';
import type { ExternalNetwork } from '@/services/feedService';

interface FediverseIconBadgeProps {
  /** Icon size in px. Defaults to 15 (inline-with-text size). */
  size?: number;
  /** Icon color class. Defaults to a muted foreground tone when no `color` is set. */
  className?: string;
  /** Explicit fill color; overrides `className`. Used where callers pass a resolved theme color. */
  color?: string;
  /** Layout class for the tappable wrapper (e.g. `self-center ml-1` at a call site). */
  containerClassName?: string;
  /** Style for the tappable wrapper (e.g. the baseline-nudge transform in UserName). */
  style?: StyleProp<ViewStyle>;
}

/**
 * Shared tappable fediverse icon that opens the educational fediverse `Dialog`.
 * This is the low-level primitive; call sites use the semantic
 * {@link FediverseSharingBadge} / {@link RemoteActorBadge} wrappers so the
 * marker's MEANING (my profile is shared vs. this actor is remote) is explicit.
 */
function FediverseIconBadge({
  size = 15,
  className,
  color,
  containerClassName,
  style,
  a11yLabel,
}: FediverseIconBadgeProps & { a11yLabel: string }) {
  const openSheet = useCallback((event?: GestureResponderEvent) => {
    // The badge is nested inside a pressable row/card (ProfileCard, post
    // header, search card); stop the click from bubbling to click-based
    // parents so tapping it opens the dialog without also triggering the
    // parent's navigation.
    event?.stopPropagation?.();
    showFediverseInfo();
  }, []);

  // The web profile hover card navigates on a raw `onPointerUp` on an ancestor
  // View — a channel `onPress`/click stopPropagation cannot reach. Stopping the
  // pointer event here keeps the parent from navigating. It does not disturb the
  // badge's own press: react-native-web's press responder is driven by
  // mouseup/touchend, not pointerup, so the sheet still opens.
  const stopPointer = useCallback((event: PointerEvent) => {
    event.stopPropagation();
  }, []);

  const iconClassName = className ?? (color ? undefined : 'text-muted-foreground');

  return (
    <Pressable
      onPress={openSheet}
      onPointerUp={stopPointer}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      hitSlop={8}
      className={containerClassName}
      style={style}
    >
      <FediverseIcon size={size} color={color} className={iconClassName} />
    </Pressable>
  );
}

/**
 * The viewer's OWN-profile fediverse-sharing marker: shows the fediverse icon
 * next to the handle when the viewer has fediverse sharing on. Tap → the
 * educational sheet explaining what sharing means.
 */
export function FediverseSharingBadge(props: FediverseIconBadgeProps) {
  const { t } = useTranslation();
  return <FediverseIconBadge {...props} a11yLabel={t('fediverse.badge.a11yLabel')} />;
}

interface RemoteActorBadgeProps extends FediverseIconBadgeProps {
  /**
   * The network the actor lives on. `activitypub` (default) shows the fediverse
   * icon; `atproto` (Bluesky) is NOT part of the fediverse, so it shows a named
   * network chip instead of the (misleading) generic fediverse icon.
   */
  network?: ExternalNetwork;
}

/**
 * Marks a REMOTE actor (a federated / cross-network account). ActivityPub
 * actors get the tappable fediverse icon; atproto (Bluesky) actors get a named
 * "Bluesky" chip so the origin is clear without implying it's the fediverse.
 */
export function RemoteActorBadge({ network = 'activitypub', ...iconProps }: RemoteActorBadgeProps) {
  const { t } = useTranslation();

  if (network === 'atproto') {
    return (
      <View className={iconProps.containerClassName} style={iconProps.style}>
        <View className="bg-secondary rounded-full px-2 py-0.5">
          <Text className="text-muted-foreground text-xs font-medium">Bluesky</Text>
        </View>
      </View>
    );
  }

  return <FediverseIconBadge {...iconProps} a11yLabel={t('fediverse.remoteBadge.a11yLabel')} />;
}
