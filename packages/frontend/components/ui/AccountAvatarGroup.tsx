import { AvatarGroup, type AvatarGroupProps } from '@oxy.so/bloom/avatar-group';
import { hasAccountAvatarCharacter, useAccountAvatarMotion } from './use-account-avatar-motion';

function AnimatedAccountAvatarGroup(props: AvatarGroupProps) {
  const motion = useAccountAvatarMotion();
  return <AvatarGroup {...props} motion={motion} />;
}

/** Keep native compatibility subscriptions out of absent and photo-only facepiles. */
export function AccountAvatarGroup(props: AvatarGroupProps) {
  if (props.motion !== undefined || !props.items.some(hasAccountAvatarCharacter)) {
    return <AvatarGroup {...props} />;
  }
  return <AnimatedAccountAvatarGroup {...props} />;
}
