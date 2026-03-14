import { Ionicons } from '@expo/vector-icons';

/**
 * Type-safe Ionicons component.
 * Ionicons' default export typing is incomplete in some Expo versions,
 * so we re-export it with the correct React component type.
 */
export const Icon = Ionicons as React.ComponentType<React.ComponentProps<typeof Ionicons>>;

export type IconName = React.ComponentProps<typeof Ionicons>['name'];
