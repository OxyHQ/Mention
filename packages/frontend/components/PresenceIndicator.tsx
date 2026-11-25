import { usePresence } from '@/hooks/usePresence';

import { VStack, type ViewModifier, defineTokens, view } from '@oxy.so/bloom-language';

interface PresenceIndicatorProps {
  userId: string | undefined;
  size?: 'small' | 'medium' | 'large';
  /** Where the caller places the dot (a pinned edge over an avatar). */
  look?: ViewModifier;
  showOffline?: boolean;
}

/** The dot's side: 8, 12 and 16pt. */
const SIZES = {
  small: 'sm',
  medium: 'md',
  large: 'lg',
} as const;

const presence = defineTokens({ color: { online: '#22c55e' } });

/**
 * Presence indicator component that shows online/offline status
 */
export const PresenceIndicator = view(function PresenceIndicator({
  userId,
  size = 'medium',
  look,
  showOffline = false,
}: PresenceIndicatorProps) {
  const isOnline = usePresence(userId);

  // Don't render if user is offline and showOffline is false
  if (!isOnline && !showOffline) {
    return null;
  }

  const side = SIZES[size];
  // A round dot ringed in the page's background.
  return VStack()
    .modifier(look)
    .frame({ width: side, height: side })
    .background(isOnline ? presence.color.online : 'muted')
    .border('background', size === 'small' ? 'thin' : 'thick')
    .corner('full');
});
