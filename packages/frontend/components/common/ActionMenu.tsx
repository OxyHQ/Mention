import React, { memo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { present, type SurfaceControls } from '@oxy.so/bloom/surfaces';

import { buildMenuGroups, type ActionMenuAction } from '@/components/common/actionMenuGroups';
import { cn } from '@/lib/utils';

interface ActionMenuGroupProps {
  actions: ActionMenuAction[];
}

/**
 * One row of an action menu. Grouped rows share a rounded card: only the first
 * and last corners are round, and a hairline gap separates the rows — the iOS
 * grouped-list shape the post menu established.
 */
const ActionMenuRow = memo(function ActionMenuRow({
  action,
  isFirst,
  isLast,
}: {
  action: ActionMenuAction;
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
 * A group of related actions inside an action menu.
 *
 * The post menu and the profile menu are the same surface and must look it —
 * they used to be two implementations, and the profile one (bare full-width
 * buttons on the sheet background, no grouping) was visibly the poor relation.
 * Compose a menu from one or more groups; each renders as its own card.
 */
export const ActionMenuGroup = memo(function ActionMenuGroup({ actions }: ActionMenuGroupProps) {
  if (actions.length === 0) return null;

  return (
    <View className="mb-1">
      {actions.map((action, index) => (
        <ActionMenuRow
          key={action.label}
          action={action}
          isFirst={index === 0}
          isLast={index === actions.length - 1}
        />
      ))}
    </View>
  );
});

interface ActionMenuRequest {
  /** Accessibility label for the surface — what the menu acts on. */
  label: string;
  /** One card per group. Empty groups are dropped. */
  groups: ActionMenuAction[][];
}

/** The menu currently on screen, so `hideActionMenu()` can dismiss it. */
let activeMenu: SurfaceControls | null = null;

/**
 * Open the app's action menu. Imperative on purpose: the menu is presented on
 * Bloom's one surface stack (the `<SurfaceProvider>` OxyProvider mounts), so a feed
 * of a thousand posts mounts no menu at all until one is pressed — the reason
 * the post menu used to push its rows into a shared bottom sheet instead of
 * rendering its own.
 *
 * The surface is a centered card from `md` up and a bottom sheet below it. One
 * surface for the post menu and the profile menu, so they cannot drift apart
 * again.
 *
 * A row's `onPress` runs AFTER the menu closes, so an action is free to open
 * another surface.
 */
export function showActionMenu(request: ActionMenuRequest): void {
  activeMenu?.dismiss();
  let own: SurfaceControls | null = null;
  void present(
    (surface) => {
      own = surface;
      activeMenu = surface;
      const groups = buildMenuGroups(request.groups, surface.dismiss);
      return (
        <View className="p-4 gap-2">
          {groups.map((actions) => (
            <ActionMenuGroup key={actions[0].label} actions={actions} />
          ))}
        </View>
      );
    },
    {
      label: request.label,
      placement: { base: 'bottom', md: 'center' },
      // The cards own their gutter; the Dialog's default 20px inset would
      // double it.
      contentPadding: 0,
    },
  ).then(() => {
    if (activeMenu === own) activeMenu = null;
  });
}

/** Close the action menu without running an action. */
export function hideActionMenu(): void {
  activeMenu?.dismiss();
  activeMenu = null;
}
