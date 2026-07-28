import React, { memo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { cn } from '@/lib/utils';

export interface SheetMenuAction {
  /** Rendered on the trailing edge — an icon element, sized by the caller. */
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  /** Text colour for destructive entries; omit for the default foreground. */
  color?: string;
}

interface SheetMenuGroupProps {
  actions: SheetMenuAction[];
}

/**
 * One row of an action sheet. Grouped rows share a rounded card: only the first
 * and last corners are round, and a hairline gap separates the rows — the iOS
 * grouped-list shape the post menu established.
 */
const SheetMenuRow = memo(function SheetMenuRow({
  action,
  isFirst,
  isLast,
}: {
  action: SheetMenuAction;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <TouchableOpacity
      className="bg-surface flex-row items-center justify-between py-3 px-3.5"
      style={{
        borderTopLeftRadius: isFirst ? 16 : 0,
        borderTopRightRadius: isFirst ? 16 : 0,
        borderBottomLeftRadius: isLast ? 16 : 0,
        borderBottomRightRadius: isLast ? 16 : 0,
        marginBottom: isLast ? 0 : 4,
      }}
      onPress={action.onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={action.label}
    >
      <Text
        className={cn('text-base font-medium', !action.color && 'text-foreground')}
        style={action.color ? { color: action.color } : undefined}
      >
        {action.label}
      </Text>
      <View className="ml-3">{action.icon}</View>
    </TouchableOpacity>
  );
});

/**
 * A group of related actions inside a bottom-sheet menu.
 *
 * The post menu and the profile menu are the same surface and must look it —
 * they used to be two implementations, and the profile one (bare full-width
 * buttons on the sheet background, no grouping) was visibly the poor relation.
 * Compose a menu from one or more groups; each renders as its own card.
 */
export const SheetMenuGroup = memo(function SheetMenuGroup({ actions }: SheetMenuGroupProps) {
  if (actions.length === 0) return null;

  return (
    <View className="mb-1">
      {actions.map((action, index) => (
        <SheetMenuRow
          key={action.label}
          action={action}
          isFirst={index === 0}
          isLast={index === actions.length - 1}
        />
      ))}
    </View>
  );
});
