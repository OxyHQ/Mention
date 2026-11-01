import { memo } from 'react';
import { View } from 'react-native';

import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import type { SurfaceControls, SurfaceRenderFn } from '@oxy.so/bloom/surfaces';

import { buildMenuGroups, type ActionMenuAction } from '@/components/common/actionMenuGroups';
import { presentCancelableSheet, presentSheet } from '@/utils/sheet';
import { OwnedSurfaceContent } from '@/components/common/OwnedSurfaceContent';

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
  /** Optional owner: abort closes only this menu. */
  signal?: AbortSignal;
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
 * A row requests the menu's dismissal before running its action; the exit
 * animation may still be in progress when the action runs.
 */
export function showActionMenu(request: ActionMenuRequest): Promise<void> {
  if (request.signal?.aborted) return Promise.resolve();
  activeMenu?.dismiss();
  if (request.signal?.aborted) return Promise.resolve();
  let own: SurfaceControls | null = null;
  const render: SurfaceRenderFn = (surface) => {
    own = surface;
    activeMenu = surface;
    const groups = buildMenuGroups(request.groups, surface.dismiss, request.signal);
    const content = (
      <View className="p-4 gap-2">
        {groups.map((actions) => (
          <ActionMenuGroup key={actions[0].label} actions={actions} />
        ))}
      </View>
    );
    return request.signal ? (
      <OwnedSurfaceContent signal={request.signal}>{content}</OwnedSurfaceContent>
    ) : (
      content
    );
  };
  const presentation = request.signal
    ? presentCancelableSheet(render, { label: request.label, signal: request.signal })
    : presentSheet(render, { label: request.label });
  return presentation.then(() => {
    if (activeMenu === own) activeMenu = null;
  });
}

/** Close the action menu without running an action. */
export function hideActionMenu(): void {
  activeMenu?.dismiss();
  activeMenu = null;
}
