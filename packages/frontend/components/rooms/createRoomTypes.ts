// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { ComponentType, ReactNode } from 'react';
import type { Room } from '@syra.fm/sdk/live';

export interface CreateRoomFormState {
  isValid: boolean;
  loading: boolean;
  hasScheduledStart: boolean;
}

export interface CreateRoomSheetProps {
  onClose: () => void;
  onRoomCreated?: (room: Room) => void;
  mode?: 'standalone' | 'embed';
  ScrollViewComponent?: ComponentType<{ children: ReactNode }>;
  hideFooter?: boolean;
  onFormStateChange?: (state: CreateRoomFormState) => void;
}
