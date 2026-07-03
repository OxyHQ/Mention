import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, type AvatarProps } from '@oxyhq/bloom/avatar';
import { useLiveUsers } from '@/hooks/useLiveUsers';
import { useLiveRoom } from '@/context/LiveRoomContext';

export interface LiveAvatarProps extends AvatarProps {
  /**
   * Oxy user id of the person this avatar represents. When set AND that user is
   * currently live in a Syra room, the avatar shows Bloom's live badge and a tap
   * joins the room instead of running the default `onPress`. Omit it (or pass a
   * user who is not live) and the avatar behaves exactly like Bloom's `Avatar`.
   */
  userId?: string;
}

/**
 * Bloom `Avatar` + Syra live presence. Reads the shared {@link useLiveUsers}
 * query (one poll for the whole app) and, for a live `userId`, overlays Bloom's
 * live badge and routes taps to `joinLiveRoom(roomId)`; otherwise it forwards
 * `onPress` untouched so non-live avatars keep their default behavior. An
 * explicit `live` prop still wins over the derived state.
 */
export function LiveAvatar({ userId, onPress, live, liveLabel, ...rest }: LiveAvatarProps) {
  const { t } = useTranslation();
  const { isLive, roomIdFor } = useLiveUsers();
  const { joinLiveRoom } = useLiveRoom();

  const userIsLive = live ?? isLive(userId);
  const roomId = roomIdFor(userId);

  const handlePress = useCallback(() => {
    if (userIsLive && roomId) {
      joinLiveRoom(roomId);
      return;
    }
    onPress?.();
  }, [userIsLive, roomId, joinLiveRoom, onPress]);

  const pressable = (userIsLive && Boolean(roomId)) || Boolean(onPress);

  return (
    <Avatar
      {...rest}
      live={userIsLive}
      liveLabel={liveLabel ?? t('liveRooms.liveBadge', { defaultValue: 'LIVE' })}
      onPress={pressable ? handlePress : undefined}
    />
  );
}
