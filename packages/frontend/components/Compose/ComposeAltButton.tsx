import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { cn } from '@/lib/utils';

interface ComposeAltButtonProps {
  /** Whether an alt description has already been entered for this image. */
  hasAlt: boolean;
  /**
   * Lift the pill above the bottom reorder controls, which occupy the bottom
   * corners whenever more than one attachment is present.
   */
  raised?: boolean;
  onPress: () => void;
}

const HITSLOP = { top: 6, bottom: 6, left: 6, right: 6 };

/**
 * Bluesky-style "ALT" pill overlaid on a composer image thumbnail. Tapping it
 * opens the alt-text input sheet. Renders a filled (primary) state once the
 * user has described the image.
 */
export const ComposeAltButton: React.FC<ComposeAltButtonProps> = ({ hasAlt, raised, onPress }) => (
  <TouchableOpacity
    onPress={onPress}
    className={cn(
      'absolute left-2 z-[3] flex-row items-center gap-0.5 rounded px-1.5 py-0.5',
      raised ? 'bottom-12' : 'bottom-2',
      hasAlt ? 'bg-primary' : 'bg-black/60',
    )}
    hitSlop={HITSLOP}
    accessibilityRole="button"
  >
    {hasAlt ? <Ionicons name="checkmark" size={11} color="#ffffff" /> : null}
    <Text className="text-white text-[11px] font-bold">ALT</Text>
  </TouchableOpacity>
);

export default ComposeAltButton;
