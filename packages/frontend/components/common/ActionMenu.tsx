import { memo } from 'react';
import { View } from 'react-native';

import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import type { SurfaceControls } from '@oxy.so/bloom/surfaces';

import { buildMenuGroups, type ActionMenuAction } from '@/components/common/actionMenuGroups';
import { presentSheet } from '@/utils/sheet';

interface ActionMenuGroupProps {
  actions: ActionMenuAction[];
}

/** Related actions rendered with Bloom's shared grouped-section styling. */
export const ActionMenuGroup = memo(function ActionMenuGroup({ actions }: ActionMenuGroupProps) {
  if (actions.length === 0) return null;

  return (
    <GroupedSection>
      {actions.map((action) => (
        <GroupedSectionItem
          key={action.label}
          title={action.label}
          titleNumberOfLines={0}
          rightElement={action.icon}
          showChevron={false}
          destructive={Boolean(action.color)}
          onPress={action.onPress}
          accessibilityLabel={action.label}
        />
      ))}
    </GroupedSection>
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
  void presentSheet(
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
    { label: request.label },
  ).then(() => {
    if (activeMenu === own) activeMenu = null;
  });
}

/** Close the action menu without running an action. */
export function hideActionMenu(): void {
  activeMenu?.dismiss();
  activeMenu = null;
}
