// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import {
  AvatarGroup,
  type AvatarGroupItem,
  type AvatarGroupProps,
} from '@oxy.so/bloom/avatar-group';
import { useMemo } from 'react';
import {
  accountAvatarCharacter,
  hasAccountAvatarCharacter,
  useAccountAvatarMotion,
} from './use-account-avatar-motion';

/** A facepile member with its account's colour (`User.color`), which paints a bot's character. */
export interface AccountAvatarGroupItem extends AvatarGroupItem {
  color?: string | null;
}

export interface AccountAvatarGroupProps extends Omit<AvatarGroupProps, 'items'> {
  items: AccountAvatarGroupItem[];
}

/**
 * A bot's character carries no paint: it is drawn in its account's colour. Bloom's
 * `AvatarGroupItem` has no `color`, so each bot member is handed over already painted.
 */
function paintMember(member: AccountAvatarGroupItem): AvatarGroupItem {
  const { color: _color, ...item } = member;
  const character = accountAvatarCharacter(member);
  return character ? { ...item, character } : item;
}

function AnimatedAccountAvatarGroup(props: AvatarGroupProps) {
  const motion = useAccountAvatarMotion();
  return <AvatarGroup {...props} motion={motion} />;
}

/** Keep native compatibility subscriptions out of absent and photo-only facepiles. */
export function AccountAvatarGroup({ items: members, ...props }: AccountAvatarGroupProps) {
  const items = useMemo(() => members.map(paintMember), [members]);
  if (props.motion !== undefined || !items.some(hasAccountAvatarCharacter)) {
    return <AvatarGroup {...props} items={items} />;
  }
  return <AnimatedAccountAvatarGroup {...props} items={items} />;
}
