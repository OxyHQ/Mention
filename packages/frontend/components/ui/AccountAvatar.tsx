// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { Avatar, type AvatarProps } from '@oxy.so/bloom/avatar';
import { hasAccountAvatarCharacter, useAccountAvatarMotion } from './use-account-avatar-motion';

function AnimatedAccountAvatar(props: AvatarProps) {
  const motion = useAccountAvatarMotion();
  return <Avatar {...props} motion={motion} />;
}

/** App policy only; photos never load the native adapter or compatibility manifest. */
export function AccountAvatar(props: AvatarProps) {
  if (
    props.motion !== undefined ||
    props.character !== undefined ||
    !hasAccountAvatarCharacter(props.account)
  ) {
    return <Avatar {...props} />;
  }
  return <AnimatedAccountAvatar {...props} />;
}
