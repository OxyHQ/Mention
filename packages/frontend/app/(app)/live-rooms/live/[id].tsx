// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useEffect } from 'react';
import { View } from 'react-native';
import { useRouter, useLocalSearchParams } from '@/lib/navigation/router';

import { useLiveRoom } from '@/context/LiveRoomContext';

/**
 * Deep link redirect: when navigating to /live-rooms/live/[id],
 * open the live room bottom sheet and go back to the live-rooms list.
 */
export default function LiveRoomRedirect() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { joinLiveRoom } = useLiveRoom();

  useEffect(() => {
    if (id) {
      joinLiveRoom(id);
      router.replace('/live-rooms');
    }
  }, [id, joinLiveRoom]);

  return <View />;
}
